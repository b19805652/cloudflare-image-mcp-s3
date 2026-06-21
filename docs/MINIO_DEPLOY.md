# MinIO Deployment & Integration Guide (Coolify & Cloudflare)

This guide details how to self-host MinIO using Docker on a Coolify-managed VPS and connect it as the storage backend for the Cloudflare Image MCP service.

---

## 🐋 1. Deploying MinIO in Coolify

Coolify makes it easy to run Docker Compose stacks. Follow these steps to spin up a production-ready MinIO instance.

### Step 1: Create a New Service in Coolify
1. Open your Coolify Dashboard.
2. Select your **Project** and **Environment**.
3. Click **+ Add New Resource** → **Docker Compose**.
4. Paste the contents of `docker-compose.minio.yml` from the root of this repository.

### Step 2: Set Environment Variables in Coolify
Define the following environment variables in the Coolify configuration:

| Variable | Recommended / Default Value | Description |
|---|---|---|
| `MINIO_ROOT_USER` | `admin` (or custom secure name) | MinIO administrative access key. |
| `MINIO_ROOT_PASSWORD` | *[A strong, unique 16+ character password]* | MinIO administrative secret key. |
| `MINIO_API_PORT` | `9000` | Port used for the S3 API endpoint. |
| `MINIO_CONSOLE_PORT` | `9001` | Port used for accessing the web control panel. |

### Step 3: Deploy the Stack
Click **Deploy** in Coolify. The container will start, and Coolify's built-in reverse proxy will assign domains if configured.

*   **API Endpoint**: Setup a domain (e.g. `https://minio-api.yourdomain.com`) routing to port `9000`.
*   **Console Endpoint**: Setup a domain (e.g. `https://minio.yourdomain.com`) routing to port `9001` for admin dashboard access.

---

## 🪣 2. Bucket Creation and Policy Configuration

Once MinIO is up:

1. Log into your MinIO Console at `https://minio.yourdomain.com` (port `9001`).
2. Go to **Buckets** in the sidebar → click **Create Bucket**.
3. Name the bucket `image-generation` (or the value set in `MINIO_BUCKET_NAME`).
4. Click **Create Bucket**.
5. In the bucket details page, ensure the access policy is configured to **Private** (the default and safest option) since the Cloudflare Worker proxies and restricts access to images anyway.

---

## 🔑 3. Cloudflare Worker Deployment configuration

### Step 1: GitHub Secrets Setup
In your forked repository, navigate to **Settings** → **Secrets and variables** → **Actions** and add these secrets:

| Secret Name | Value | Description |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | *[Cloudflare Account ID]* | Required. |
| `CLOUDFLARE_API_TOKEN` | *[Cloudflare Workers API Token]* | Required. |
| `MINIO_ENDPOINT` | `https://minio-api.yourdomain.com` | The URL of your VPS MinIO API (without ending slash). |
| `MINIO_ACCESS_KEY_ID` | *[MINIO_ROOT_USER]* | The Access Key ID. |
| `MINIO_SECRET_ACCESS_KEY` | *[MINIO_ROOT_PASSWORD]* | The Secret Access Key. |
| `MINIO_BUCKET_NAME` | `image-generation` | Optional (defaults to `image-generation`). |
| `MINIO_REGION` | `us-east-1` | Optional (defaults to `us-east-1`). |

### Step 2: Trigger Deploy
Push your commits to the `main` branch or manually trigger the **Deploy to Cloudflare Workers** action from the Actions tab.

---

## 🧪 4. Testing & Verification

Verify the end-to-end flow using the following steps:

1. Run the health check:
   ```bash
   curl https://cloudflare-image-workers.<your-subdomain>.workers.dev/health
   ```
2. Request an image generation via the OpenAI API endpoint:
   ```bash
   curl -X POST https://cloudflare-image-workers.<your-subdomain>.workers.dev/v1/images/generations \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <your_api_key>" \
     -d '{
       "prompt": "A beautiful cinematic digital painting of a floating island",
       "model": "@cf/bytedance/stable-diffusion-xl-lightning"
     }'
   ```
3. Copy the URL returned in the response (e.g. `https://<worker-url>/images/2026-06-21/abc1234-xyz.png`).
4. Load the URL in a browser. It should serve the image successfully.
5. Inspect the MinIO bucket console. You should see a folder structure like `images/2026-06-21/` containing your generated image.

---

## 🔍 5. Troubleshooting Checklist

*   **Error: `SignatureDoesNotMatch` or `InvalidAccessKeyId`**
    *   *Fix*: Check that `MINIO_ACCESS_KEY_ID` and `MINIO_SECRET_ACCESS_KEY` exactly match the credentials configured in Coolify.
*   **Error: `TypeError: Cannot read properties of undefined (reading 'get')` or compilation errors**
    *   *Fix*: Ensure that you have run `npm run check` to verify TypeScript builds. Verify that `nodejs_compat` compatibility flag is enabled under `compatibility_flags` in wrangler.toml or set correctly in the GitHub Action file.
*   **Error: HTTP 500 when retrieving images**
    *   *Fix*: Check the Cloudflare Workers real-time logs (`npx wrangler tail`) to view the exact S3 connection error. If using self-hosted MinIO, verify that SSL/TLS is set up correctly and the endpoint is accessible from the internet.
