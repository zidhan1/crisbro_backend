const path = require('path');
const swaggerUi = require('swagger-ui-express');
const swaggerUiDist = require('swagger-ui-dist');
const YAML = require('yamljs');

const openApiSpec = YAML.load(path.join(__dirname, 'openapi.yaml'));
const swaggerUiDistPath = swaggerUiDist.getAbsoluteFSPath();

const swaggerUiOptions = {
  explorer: true,
  customSiteTitle: 'Crisbar Rewards API Docs',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    tagsSorter: 'alpha',
    operationsSorter: 'method',
  },
};

module.exports = {
  openApiSpec,
  swaggerUi,
  swaggerUiDistPath,
  swaggerUiOptions,
};
