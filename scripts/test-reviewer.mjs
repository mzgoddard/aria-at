/** @format */

import {spawnSync} from 'child_process';
import fs from 'fs';
import path from 'path';

import fse from 'fs-extra';
import mustache from 'mustache';
import np from 'node-html-parser';

import {commandsAPI} from '../tests/resources/at-commands.mjs';

import minimist from 'minimist';
const args = minimist(process.argv.slice(2), {
  string: ['outDir'],
  default: {
    outDir: '',
  },
  alias: {
    h: 'help',
    o: 'outDir',
  },
});

if (args.help) {
  console.log(`
Default use:
  node test-reviewer.mjs
    Will create reviews from information in the html and json files in tests/*.

  Arguments:
    -h, --help
      Show this message.
    -o, --outDir
      Directory to generate files in.
`);
  process.exit();
}

createTestReviews({outputDirectory: args.outDir});

/**
 * @typedef CreateTestReviewsOptions
 * @property {string} [rootDirectory]
 * @property {string} [outputDirectory]
 * @property {string} [templateDirectory]
 */

/**
 * @param {CreateTestReviewsOptions} param0
 */
function createTestReviews({
  rootDirectory = path.resolve('.'),
  outputDirectory: outputDirectory = '',
  templateDirectory = 'scripts',
} = {}) {
  outputDirectory = path.resolve(rootDirectory, outputDirectory);
  templateDirectory = path.resolve(rootDirectory, templateDirectory);

  const allTestsDirectory = path.resolve(rootDirectory, 'tests');
  const reviewTemplateFilepath = path.resolve(templateDirectory, 'review-template.mustache');
  const reviewIndexTemplateFilepath = path.resolve(templateDirectory, 'review-index-template.mustache');
  const reviewDirectory = path.resolve(outputDirectory, 'review');
  const supportFilepath = path.join(allTestsDirectory, 'support.json');

  const allTestsForPattern = {};
  const support = JSON.parse(fse.readFileSync(supportFilepath));
  let allATKeys = [];
  support.ats.forEach(at => {
    allATKeys.push(at.key);
  });
  const scripts = [];

  const getPriorityString = function (priority) {
    priority = parseInt(priority);
    if (priority === 1) {
      return 'required';
    } else if (priority === 2) {
      return 'optional';
    }
    return '';
  };

  fse.readdirSync(allTestsDirectory).forEach(function (subDir) {
    const subDirFullPath = path.join(allTestsDirectory, subDir);
    const stat = fse.statSync(subDirFullPath);
    if (stat.isDirectory() && subDir !== 'resources') {
      // Initialize the commands API
      const commandsJSONFile = path.join(subDirFullPath, 'commands.json');
      const commands = JSON.parse(fse.readFileSync(commandsJSONFile));
      const commAPI = new commandsAPI(commands, support);

      const tests = [];

      const referencesCsv = fs.readFileSync(path.join(subDirFullPath, 'data', 'references.csv'), 'UTF-8');
      const reference = referencesCsv
        .split(/\r?\n/)
        .find(s => s.startsWith('reference,'))
        .split(',')[1];

      const scriptsPath = path.join(subDirFullPath, 'data', 'js');
      fse.readdirSync(scriptsPath).forEach(function (scriptFile) {
        let script = '';
        try {
          const data = fs.readFileSync(path.join(scriptsPath, scriptFile), 'UTF-8');
          const lines = data.split(/\r?\n/);
          lines.forEach(line => {
            if (line.trim().length) script += '\t' + line.trim() + '\n';
          });
        } catch (err) {
          console.error(err);
        }
        scripts.push(`\t${scriptFile.split('.js')[0]}: function(testPageDocument){\n${script}}`);
      });

      fse.readdirSync(subDirFullPath).forEach(function (test) {
        if (path.extname(test) === '.html' && path.basename(test) !== 'index.html') {
          const testFile = path.join(allTestsDirectory, subDir, test);
          const root = np.parse(fse.readFileSync(testFile, 'utf8'), {script: true});

          // Get metadata
          const testFullName = root.querySelector('title').innerHTML;
          const helpLinks = [];
          for (let link of root.querySelectorAll('link')) {
            if (link.attributes.rel === 'help') {
              let href = link.attributes.href;
              let text;
              if (href.indexOf('#') >= 0) {
                text = `ARIA specification: ${href.split('#')[1]}`;
              } else {
                text = `APG example: ${href.split('examples/')[1]}`;
              }

              helpLinks.push({
                link: href,
                text: text,
              });
            }
          }

          let testData = JSON.parse(
            fse.readFileSync(path.join(subDirFullPath, path.parse(test).name + '.json'), 'utf8'),
          );

          const userInstruction = testData.specific_user_instruction;
          const task = testData.task;

          // This is temporary while transitioning from lists to strings
          const mode = typeof testData.mode === 'string' ? testData.mode : testData.mode[0];

          const ATTests = [];

          // TODO: These apply_to strings are not standarized yet.
          let allReleventATs = [];
          if (
            testData.applies_to[0].toLowerCase() === 'desktop screen readers' ||
            testData.applies_to[0].toLowerCase() === 'screen readers'
          ) {
            allReleventATs = allATKeys;
          } else {
            allReleventATs = testData.applies_to;
          }

          for (const atKey of allReleventATs.map(a => a.toLowerCase())) {
            let commands, assertions;
            let at = commAPI.isKnownAT(atKey);

            try {
              commands = commAPI.getATCommands(mode, task, at);
            } catch (error) {
              // An error will occur if there is no data for a screen reader, ignore it
            }

            if (testData.additional_assertions && testData.additional_assertions[at.key]) {
              assertions = testData.additional_assertions[at.key];
            } else {
              assertions = testData.output_assertions;
            }

            ATTests.push({
              atName: at.name,
              atKey: at.key,
              commands: commands && commands.length ? commands : undefined,
              assertions:
                assertions && assertions.length
                  ? assertions.map(a => ({priority: getPriorityString(a[0]), description: a[1]}))
                  : undefined,
              userInstruction,
              modeInstruction: commAPI.getModeInstructions(mode, at),
              setupScriptDescription: testData.setup_script_description,
            });
          }

          // Create the test review pages
          const testFilePath = path.join(rootDirectory, 'tests', subDir, test);
          const lastEdited = gitLastCommitDate(testFilePath);

          tests.push({
            testNumber: tests.length + 1,
            name: testFullName,
            location: `/${subDir}/${test}`,
            reference: `/${subDir}/${reference}`,
            allReleventATsFormatted: testData.applies_to.join(', '),
            allReleventATs: testData.applies_to,
            setupScriptName: testData.setupTestPage,
            task,
            mode,
            ATTests,
            helpLinks,
            lastEdited,
          });
        }
      });

      if (tests.length) {
        allTestsForPattern[subDir] = tests;
      }
    }
  });

  var template = fse.readFileSync(reviewTemplateFilepath, 'utf8');
  if (!fse.existsSync(reviewDirectory)) {
    fse.mkdirSync(reviewDirectory);
  }

  var indexTemplate = fse.readFileSync(reviewIndexTemplateFilepath, 'utf8');

  console.log('\n');

  for (let pattern in allTestsForPattern) {
    var rendered = mustache.render(template, {
      pattern: pattern,
      totalTests: allTestsForPattern[pattern].length,
      tests: allTestsForPattern[pattern],
      AToptions: support.ats,
      setupScripts: scripts,
    });

    let summaryFile = path.join(reviewDirectory, `${pattern}.html`);
    fse.writeFileSync(summaryFile, rendered);
    console.log(`Summarized ${pattern} tests: ${summaryFile}`);
  }

  const renderedIndex = mustache.render(indexTemplate, {
    patterns: Object.keys(allTestsForPattern).map(pattern => {
      const lastCommit = gitLastCommitLine(path.join(rootDirectory, 'tests', pattern));
      return {
        name: pattern,
        numberOfTests: allTestsForPattern[pattern].length,
        commit: lastCommit.split(' ')[0],
        commitDescription: lastCommit,
      };
    }),
  });
  const indexFile = path.join(outputDirectory, 'index.html');
  fse.writeFileSync(indexFile, renderedIndex);
  console.log(`Generated: ${indexFile}`);

  console.log('\n\nDone.');
}

function gitLastCommitDate(filePath) {
  const output = spawnSync('git', ['log', '-1', '--format="%ad"', filePath]);
  const lastEdited = output.stdout.toString().replace(/"/gi, '').replace('\n', '');
  return lastEdited;
}

function gitLastCommitLine(filePath) {
  return spawnSync('git', ['log', '-n1', '--oneline', filePath]).stdout.toString();
}
