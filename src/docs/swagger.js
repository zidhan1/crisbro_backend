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

function renderSwaggerHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${swaggerUiOptions.customSiteTitle}</title>
  <link rel="stylesheet" href="/api/docs/swagger-ui.css">
  <link rel="icon" type="image/png" href="/api/docs/favicon-32x32.png" sizes="32x32">
  <style>
    html {
      box-sizing: border-box;
      overflow-y: scroll;
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    body {
      margin: 0;
      background: #fafafa;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/docs/swagger-ui-bundle.js"></script>
  <script src="/api/docs/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/api/docs/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true,
        displayRequestDuration: true,
        tagsSorter: 'alpha',
        operationsSorter: 'method',
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: 'StandaloneLayout'
      });
    };
  </script>
</body>
</html>`;
}

module.exports = {
  openApiSpec,
  renderSwaggerHtml,
  swaggerUi,
  swaggerUiDistPath,
  swaggerUiOptions,
};
