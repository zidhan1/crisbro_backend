const path = require('path');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

const openApiSpec = YAML.load(path.join(__dirname, 'openapi.yaml'));
const swaggerUiAssetVersion = '5.32.8';

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

function renderSwaggerHtml(nonce) {
  const swaggerOptions = swaggerUiOptions.swaggerOptions;
  // L-2: Menambahkan nonce unik pada setiap script dan style inline agar sesuai dengan kebijakan CSP dan tetap aman dijalankan.
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${swaggerUiOptions.customSiteTitle}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${swaggerUiAssetVersion}/swagger-ui.css">
  <link rel="icon" type="image/png" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${swaggerUiAssetVersion}/favicon-32x32.png" sizes="32x32">
  <style${nonceAttr}>
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
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${swaggerUiAssetVersion}/swagger-ui-bundle.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${swaggerUiAssetVersion}/swagger-ui-standalone-preset.js"></script>
  <script${nonceAttr}>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/api/docs/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: ${Boolean(swaggerOptions.persistAuthorization)},
        displayRequestDuration: ${Boolean(swaggerOptions.displayRequestDuration)},
        tagsSorter: '${swaggerOptions.tagsSorter}',
        operationsSorter: '${swaggerOptions.operationsSorter}',
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
  swaggerUiOptions,
};
