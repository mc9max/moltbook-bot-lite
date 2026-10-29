// R2 image hosting — upload hero images to Cloudflare R2 via its
// S3-compatible API, mirroring the tech-news bot's uploader.
//
// No new dependencies: the PUT is signed with AWS Signature Version 4
// (SigV4) using node:crypto and the global fetch (Node >= 20).
// R2's region is always "auto".
//
// Configuration comes from environment variables (set on the Railway
// service, never committed):
//
//   R2_ENDPOINT           e.g. https://<account_id>.r2.cloudflarestorage.com
//   R2_BUCKET             e.g. blog-images
//   R2_ACCESS_KEY_ID      R2 API token's access key
//   R2_SECRET_ACCESS_KEY  R2 API token's secret (shown once at creation)
//   R2_PUBLIC_URL         e.g. https://cdn.freeq.one
//
// Objects are stored under the `heroes/` prefix and served publicly
// through the custom domain bound to the bucket, so the returned URL is
// `{R2_PUBLIC_URL}/heroes/{remoteFilename}`.
//
// Failure contract: any problem — missing config, non-2xx response —
// logs and returns null, so the caller can fall back (pool hero) or go
// hero-less. There is no fallback host: temp hosts (catbox) broke
// published heroes before, so a failed upload must never silently
// substitute one.

import * as crypto from "crypto";

const REGION = "auto";
const SERVICE = "s3";

/** Load R2 config from environment; null when any variable is missing. */
export function loadR2Config() {
  const endpoint = (process.env.R2_ENDPOINT ?? "").trim();
  const bucket = (process.env.R2_BUCKET ?? "").trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY ?? "").trim();
  const publicUrl = (process.env.R2_PUBLIC_URL ?? "").trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicUrl) {
    return null;
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey, publicUrl };
}

function hmac(key, msg) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest();
}

/** Strict S3 path-segment encoding (encodeURIComponent + the RFC 3986 extras). */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function signHeaders(method, path, host, body, contentType, config) {
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");

  const headers = {
    "content-type": contentType,
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");
  const canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * PUT an image buffer to R2 and return its public URL, or null on failure.
 * remoteFilename should already carry its extension (e.g. "x.jpg").
 */
export async function uploadToR2(
  body,
  remoteFilename,
  config = loadR2Config(),
) {
  if (!config) {
    console.error(
      "r2-upload: config missing; set R2_ENDPOINT, R2_BUCKET, " +
        "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL",
    );
    return null;
  }

  const contentType = "image/jpeg";
  const key = `heroes/${remoteFilename}`;
  // Path-style S3 URL.
  const encodedPath = `/${[config.bucket, "heroes", remoteFilename]
    .map(encodeSegment)
    .join("/")}`;
  const endpoint = config.endpoint.replace(/\/$/, "");
  const url = `${endpoint}${encodedPath}`;
  const host = endpoint.replace(/^https?:\/\//, "");
  const headers = signHeaders("PUT", encodedPath, host, body, contentType, config);

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      console.error(
        `r2-upload: upload failed: HTTP ${res.status} ` +
          `(${(await res.text()).slice(0, 200)})`,
      );
      return null;
    }
  } catch (err) {
    console.error(
      `r2-upload: request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const publicUrl = `${config.publicUrl.replace(/\/$/, "")}/${key}`;
  console.log(`r2-upload: upload succeeded: ${publicUrl}`);
  return publicUrl;
}
