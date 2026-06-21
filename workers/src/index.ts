// ============================================================================
// Main Worker Entry Point
// Routes all requests to appropriate handlers
// ============================================================================

import type { Env } from './types.js';
import { OpenAIEndpoint } from './endpoints/openai-endpoint.js';
import { MCPEndpoint } from './endpoints/mcp-endpoint.js';
import { serveFrontend } from './endpoints/frontend.js';
import { listModels } from './config/models.js';
import { authenticateRequest, requiresAuth, createUnauthorizedResponse } from './middleware/auth.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Temporary request logging to MinIO
    if (request.method === 'POST') {
      try {
        const clone = request.clone();
        const contentType = clone.headers.get('content-type') || '';
        let bodyInfo = '';
        if (contentType.includes('application/json')) {
          bodyInfo = await clone.text();
        } else if (contentType.includes('multipart/form-data')) {
          const formData = await clone.formData();
          const keys: string[] = [];
          formData.forEach((_, key) => {
            if (!keys.includes(key)) keys.push(key);
          });
          bodyInfo = `Multipart keys: ${keys.join(', ')}`;
          for (const key of keys) {
            const val = formData.get(key);
            if (val && typeof val === 'object' && 'size' in val) {
              bodyInfo += `\n- File key="${key}", name="${(val as any).name}", size=${(val as any).size}, type="${(val as any).type}"`;
            } else {
              bodyInfo += `\n- Text key="${key}", value="${String(val).substring(0, 500)}"`;
            }
          }
        } else {
          bodyInfo = `Other body type: ${contentType}`;
        }

        const headersObj: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          headersObj[key] = value;
        });

        const logContent = `Time: ${new Date().toISOString()}
Method: ${request.method}
Path: ${path}
Headers: ${JSON.stringify(headersObj, null, 2)}
BodyInfo:
${bodyInfo}`;

        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({
          endpoint: env.MINIO_ENDPOINT,
          region: env.MINIO_REGION || 'us-east-1',
          credentials: {
            accessKeyId: env.MINIO_ACCESS_KEY_ID,
            secretAccessKey: env.MINIO_SECRET_ACCESS_KEY,
          },
          forcePathStyle: env.MINIO_FORCE_PATH_STYLE === 'true' || true,
        });
        const bucketName = env.MINIO_BUCKET_NAME || 'image-generation';
        
        const timestamp = Date.now();
        const logKey = `logs/${timestamp}-${Math.random().toString(36).substring(2, 6)}.txt`;
        await s3.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: logKey,
            Body: new TextEncoder().encode(logContent),
            ContentType: 'text/plain',
          })
        );
      } catch (logErr) {
        console.error('Failed to upload log:', logErr);
      }
    }

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Check authentication for protected routes
      if (requiresAuth(path, request.method)) {
        const authResult = authenticateRequest(request, env);
        if (!authResult.authenticated) {
          return createUnauthorizedResponse(authResult.error);
        }
      }

      // Route: Frontend
      if (path === '/' || path === '/index.html') {
        return serveFrontend();
      }

      // Route: Health check
      if (path === '/health') {
        const timezone = env.TZ || 'UTC';
        const now = new Date();

        // Format current time in configured timezone
        let currentTime: string;
        try {
          currentTime = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          }).format(now);
        } catch (err) {
          currentTime = now.toISOString();
        }

        // Format deployedAt in configured timezone if available
        let deployedAtFormatted = env.DEPLOYED_AT || 'unknown';
        if (env.DEPLOYED_AT && env.DEPLOYED_AT !== 'unknown') {
          try {
            const deployedDate = new Date(env.DEPLOYED_AT);
            deployedAtFormatted = new Intl.DateTimeFormat('en-US', {
              timeZone: timezone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            }).format(deployedDate);
          } catch (err) {
            // Keep original value if parsing fails
          }
        }

        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: Date.now(),
          currentTime,
          timezone,
          version: '0.1.0',
          deployedAt: deployedAtFormatted,
          commitSha: env.COMMIT_SHA || 'unknown',
          authEnabled: !!env.API_KEYS,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Route: OpenAI-compatible API (handles /v1/* and fallback /images/generations, /images/edits, or /images/variations)
      if (
        path.startsWith('/v1/') ||
        path === '/images/generations' || path === '/images/generations/' ||
        path === '/images/edits' || path === '/images/edits/' ||
        path === '/images/variations' || path === '/images/variations/'
      ) {
        const openai = new OpenAIEndpoint(env);
        return openai.handle(request);
      }

      // Route: MCP endpoint (handles /mcp, /mcp/message, /mcp/?transport=sse)
      if (path === '/mcp' || path === '/mcp/message' || path.startsWith('/mcp/')) {
        const mcp = new MCPEndpoint(env);
        return mcp.handle(request);
      }

      // Route: API endpoints
      if (path === '/api/internal/models') {
        const models = listModels();
        return new Response(JSON.stringify(models), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Route: Image proxy (serve images from S3 through the worker)
      if (path.startsWith('/images/')) {
        const imageKey = path.substring(1); // Remove leading slash
        try {
          const { S3StorageService } = await import('./services/s3-storage.js');
          const storage = new S3StorageService(env);
          const image = await storage.getImageByKey(imageKey);
          if (!image) {
            return new Response('Image not found', { status: 404 });
          }
          return new Response(image.data, {
            headers: {
              'Content-Type': image.contentType || 'image/png',
              'Cache-Control': 'public, max-age=86400',
            },
          });
        } catch (error) {
          console.error('Error fetching image:', error);
          return new Response('Error fetching image', { status: 500 });
        }
      }

      // 404 for unknown routes
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },

  // Scheduled task for cleanup (cron job)
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === '0 * * * *') { // Every hour
      const { ImageGeneratorService } = await import('./services/image-generator.js');
      const generator = new ImageGeneratorService(env);
      const deleted = await generator.cleanupExpired();
      console.log(`Cleaned up ${deleted} expired images`);
    }
  },
} satisfies ExportedHandler<Env>;
