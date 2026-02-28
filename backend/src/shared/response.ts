import type { APIGatewayProxyResult } from 'aws-lambda';

/**
 * Build a standard API Gateway response with CORS headers.
 */
export function apiResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify(body),
  };
}

export function success(body: unknown): APIGatewayProxyResult {
  return apiResponse(200, body);
}

export function created(body: unknown): APIGatewayProxyResult {
  return apiResponse(201, body);
}

export function badRequest(message: string): APIGatewayProxyResult {
  return apiResponse(400, { error: message });
}

export function notFound(message = 'Not found'): APIGatewayProxyResult {
  return apiResponse(404, { error: message });
}

export function serverError(message = 'Internal server error'): APIGatewayProxyResult {
  return apiResponse(500, { error: message });
}
