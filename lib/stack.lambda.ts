import { APIGatewayProxyHandler } from 'aws-lambda';

export const handler: APIGatewayProxyHandler = async (event) => {
  const headers = event.headers;
  const responseBody = `<!DOCTYPE html><html><head><title>ALB</title></head><body><h1>Routing Test </h1><b>Time:</b>${new Date()}<br><h2>These are the headers and their values passed through from ALB+Cognito to a Lambda sitting behind the ALB</h2><b>Auth flow is:</b>User-\>ALB-\>Cognito-\>ALB-\>Lambda<br><p>${Object.entries(headers).map(([k, v], i) => `<b>${k}</b>: ${v}`).join('<br>')}</p></body></html>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html',
    },
    body: responseBody,
  };
};
