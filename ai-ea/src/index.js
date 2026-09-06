'use strict';

// Single entry point for embedding the engine in another program.

module.exports = {
  ledger: require('./ledger'),
  taxonomy: require('./taxonomy'),
  finance: require('./finance'),
  research: require('./research'),
  client: require('./client'),
  brief: require('./brief'),
};
