/** @format */

'use strict';
const {createExampleTests} = require('./create-example-tests');

const minimist = require('minimist');
const args = minimist(process.argv.slice(2), {
  string: ['outDir'],
  default: {
    outDir: '',
  },
  alias: {
    h: 'help',
    i: 'initialize', // future feature
    o: 'outDir',
  },
});

if (args.help) {
  console.log(`
Default use:
  node create-tests.js ...directories
    Will create tests from information in the [path to test files]/data/ directory
    The data directory needs to have the following CSV files:
      commands.csv
      references.csv
      test.csv

  Examples:
    node create-tests.js tests/checkbox
    node create-tests.js tests/*
    node create-tests.js --outDir dist tests/*

  Arguments:
    ...directories
      Directories to read tests from.
    -h, --help
      Show this message.
    -o, --outDir
      Directory to generate tests in.
`);
  process.exit();
}

if (args._.length !== 1) {
  console.log('Command expects a directory name, please supply.');
  process.exit();
}

args._.map(source => createExampleTests({testPlan: source, outputDirectory: args.outDir}));
