import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { receipt, text, toolError } from "../util/mcp.js";
import FormData from "form-data";
import fetch from "node-fetch";
import { requireMatchingConfirmation } from "../util/inputSchemas.js";
import { readLimitedResponseBody } from "../util/httpResponse.js";
import { readImageSize } from "../util/imageSize.js";

export type BlobContentEncoding = "utf8" | "base64";

export type BlobUploadConfig = {
  maxDecodedBytes: number;
  timeoutMs: number;
  maxResponseBytes: number;
};

const DEFAULT_MAX_DECODED_BYTES = 25 * 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MULTIPART_MANAGED_HEADERS = new Set([
  "content-length",
  "content-type",
  "transfer-encoding",
]);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type BlobUploadGraphQLResponse = {
  data?: {
    setBlob?: unknown;
  };
  errors?: Array<{
    message?: unknown;
  }>;
};

class BlobUploadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Blob upload timed out after ${timeoutMs}ms.`);
    this.name = "BlobUploadTimeoutError";
  }
}

function parsePositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  max?: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const normalized = raw.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must not exceed ${max}. Received: ${raw}`);
  }
  return parsed;
}

export function loadBlobUploadConfig(env: NodeJS.ProcessEnv = process.env): BlobUploadConfig {
  return {
    maxDecodedBytes: parsePositiveInteger(
      "AFFINE_BLOB_UPLOAD_MAX_BYTES",
      env.AFFINE_BLOB_UPLOAD_MAX_BYTES,
      DEFAULT_MAX_DECODED_BYTES,
    ),
    timeoutMs: parsePositiveInteger(
      "AFFINE_BLOB_UPLOAD_TIMEOUT_MS",
      env.AFFINE_BLOB_UPLOAD_TIMEOUT_MS,
      DEFAULT_UPLOAD_TIMEOUT_MS,
      MAX_TIMER_DELAY_MS,
    ),
    maxResponseBytes: parsePositiveInteger(
      "AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES",
      env.AFFINE_BLOB_UPLOAD_RESPONSE_MAX_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
    ),
  };
}

function assertWithinDecodedLimit(size: number, maxDecodedBytes: number): void {
  if (size > maxDecodedBytes) {
    throw new Error(`Blob content is ${size} bytes after decoding; the configured limit is ${maxDecodedBytes} bytes.`);
  }
}

export function decodeBlobContent(
  content: string,
  encoding: BlobContentEncoding = "utf8",
  maxDecodedBytes: number = DEFAULT_MAX_DECODED_BYTES,
): Buffer {
  if (encoding === "utf8") {
    const size = Buffer.byteLength(content, "utf8");
    assertWithinDecodedLimit(size, maxDecodedBytes);
    return Buffer.from(content, "utf8");
  }

  const normalized = content.replace(/[ \t\r\n\f]/g, "");
  if (!CANONICAL_BASE64.test(normalized)) {
    throw new Error("Blob content is not valid canonical Base64.");
  }

  const paddingBytes = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const decodedSize = (normalized.length / 4) * 3 - paddingBytes;
  assertWithinDecodedLimit(decodedSize, maxDecodedBytes);

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error("Blob content is not valid canonical Base64.");
  }
  return decoded;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
};

function guessMime(name: string): string | undefined {
  return MIME_BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""];
}

// filePath/url read from the machine running the server, so they are only
// allowed for a local stdio server (in HTTP mode they would be file read / SSRF).
async function loadBlobSource(
  src: { content?: string; encoding: BlobContentEncoding; filePath?: string; url?: string },
  maxDecodedBytes: number,
): Promise<{ payload: Buffer; filename?: string; contentType?: string }> {
  const given = [src.content !== undefined, !!src.filePath, !!src.url].filter(Boolean).length;
  if (given !== 1) throw new Error("Provide exactly one of content, filePath, or url.");
  if (src.content !== undefined) {
    return { payload: decodeBlobContent(src.content, src.encoding, maxDecodedBytes) };
  }
  const transport = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
  if (transport !== "stdio") throw new Error("filePath and url are only available with MCP_TRANSPORT=stdio.");
  if (src.filePath) {
    const { readFile, stat } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    assertWithinDecodedLimit((await stat(src.filePath)).size, maxDecodedBytes);
    const name = basename(src.filePath);
    return { payload: await readFile(src.filePath), filename: name, contentType: guessMime(name) };
  }
  const url = new URL(src.url as string);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("url must be http(s).");
  const response = await fetch(url.href, { redirect: "follow" });
  if (!response.ok) throw new Error(`Fetching url failed with HTTP ${response.status}.`);
  const payload = Buffer.from(await response.arrayBuffer());
  assertWithinDecodedLimit(payload.length, maxDecodedBytes);
  const name = decodeURIComponent(url.pathname.split("/").pop() || "") || undefined;
  const headerType = response.headers.get("content-type")?.split(";")[0].trim();
  return { payload, filename: name, contentType: headerType || (name ? guessMime(name) : undefined) };
}

function parseUploadResponse(body: string): BlobUploadGraphQLResponse {
  if (!body) {
    throw new Error("Blob upload returned an empty response.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Blob upload returned a response that was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Blob upload returned a JSON value that was not an object.");
  }
  return parsed as BlobUploadGraphQLResponse;
}

function firstGraphQLError(result: BlobUploadGraphQLResponse): string | null {
  const message = result?.errors?.[0]?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function validateMultipartMetadata(value: string, label: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain null bytes or line breaks.`);
  }
  if (Buffer.byteLength(value, "utf8") > 255) {
    throw new Error(`${label} must not exceed 255 UTF-8 bytes.`);
  }
  return value;
}

function buildMultipartHeaders(
  headers: Record<string, string>,
  formHeaders: Record<string, string>,
): Record<string, string> {
  const preserved = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !MULTIPART_MANAGED_HEADERS.has(name.toLowerCase()),
    ),
  );
  return {
    ...preserved,
    ...formHeaders,
  };
}

export function registerBlobTools(
  server: McpServer,
  gql: GraphQLClient,
  uploadConfig: BlobUploadConfig = loadBlobUploadConfig(),
) {
  // UPLOAD BLOB/FILE
  const uploadBlobHandler = async ({
    workspaceId,
    content,
    encoding = "utf8",
    filePath,
    url,
    filename,
    contentType,
  }: {
    workspaceId: string;
    content?: string;
    filePath?: string;
    url?: string;
    encoding?: BlobContentEncoding;
    filename?: string;
    contentType?: string;
  }) => {
    try {
      const { endpoint, headers } = await gql.getConnectionAuth();
      const source = await loadBlobSource({ content, encoding, filePath, url }, uploadConfig.maxDecodedBytes);
      const payload = source.payload;
      const safeFilename = validateMultipartMetadata(filename ?? source.filename ?? `blob-${Date.now()}.bin`, "filename");
      const mime = validateMultipartMetadata(contentType ?? source.contentType ?? "application/octet-stream", "contentType");

      const form = new FormData();
      form.append("operations", JSON.stringify({
        query: `mutation SetBlob($workspaceId: String!, $blob: Upload!) {
          setBlob(workspaceId: $workspaceId, blob: $blob)
        }`,
        variables: {
          workspaceId,
          blob: null
        }
      }));
      form.append("map", JSON.stringify({ "0": ["variables.blob"] }));
      form.append("0", payload, { filename: safeFilename, contentType: mime });

      const requestHeaders = buildMultipartHeaders(headers, form.getHeaders());

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), uploadConfig.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: requestHeaders,
          body: form as any,
          signal: controller.signal,
        });
        const responseBody = await readLimitedResponseBody(
          response,
          uploadConfig.maxResponseBytes,
          "Blob upload response",
        );
        let result: BlobUploadGraphQLResponse;
        try {
          result = parseUploadResponse(responseBody);
        } catch (error) {
          if (!response.ok) {
            throw new Error(`Blob upload failed with HTTP ${response.status}.`);
          }
          throw error;
        }

        const graphQLError = firstGraphQLError(result);
        if (!response.ok) {
          const detail = graphQLError ? `: ${graphQLError}` : "";
          throw new Error(`Blob upload failed with HTTP ${response.status}${detail}`);
        }
        if (graphQLError) {
          throw new Error(graphQLError);
        }
        const blobKey = result.data?.setBlob;
        if (typeof blobKey !== "string" || !blobKey.trim()) {
          throw new Error("Upload succeeded but no blob key was returned.");
        }

        return text({
          id: blobKey,
          key: blobKey,
          workspaceId,
          filename: safeFilename,
          contentType: mime,
          encoding,
          size: payload.length,
          ...(readImageSize(payload) ?? {}),
          uploadedAt: new Date().toISOString()
        });
      } catch (error: any) {
        if (controller.signal.aborted) {
          throw new BlobUploadTimeoutError(uploadConfig.timeoutMs);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error: any) {
      return toolError(error, {
        code: error instanceof BlobUploadTimeoutError
          ? "blob_upload_timeout"
          : "blob_upload_failed",
        retryable: false,
        data: {
          kind: "blob.upload",
          status: "failed",
          workspaceId,
          encoding,
        },
      });
    }
  };
  server.registerTool(
    "upload_blob",
    {
      title: "Upload Blob",
      description: "Upload a file or blob into AFFiNE workspace storage and return its blob key. For images the result also includes pixel width/height; pass the key as sourceId to append_block type=image (with x/y on the edgeless canvas). This creates stored content but does not attach it to a document by itself.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id that owns the blob."),
        content: z.string().optional().describe("Blob content encoded according to the encoding field. Provide exactly one of content, filePath, or url."),
        filePath: z.string().min(1).optional().describe("Absolute path of a local file to upload (stdio transport only). Filename and MIME type are inferred."),
        url: z.string().url().optional().describe("http(s) URL to download and upload (stdio transport only). Filename and MIME type are inferred."),
        encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Content encoding. Defaults to utf8; use base64 explicitly for binary data."),
        filename: z.string().min(1).max(255).optional().describe("Optional filename stored with the upload. Defaults to a generated .bin name."),
        contentType: z.string().min(1).max(255).optional().describe("Optional MIME type. Defaults to application/octet-stream.")
      }
    },
    uploadBlobHandler as any
  );

  // DELETE BLOB
  const deleteBlobHandler = async ({ workspaceId, key, permanently = false, confirmKey }: { workspaceId: string; key: string; permanently?: boolean; confirmKey?: string }) => {
    try {
      if (permanently) {
        requireMatchingConfirmation("permanent delete_blob", key, confirmKey);
      }
      const mutation = `
        mutation DeleteBlob($workspaceId: String!, $key: String!, $permanently: Boolean) {
          deleteBlob(workspaceId: $workspaceId, key: $key, permanently: $permanently)
        }
      `;
      
      const data = await gql.request<{ deleteBlob: boolean }>(mutation, {
        workspaceId,
        key,
        permanently
      });

      if (!data.deleteBlob) {
        return toolError("AFFiNE did not confirm blob deletion.", {
          code: "blob_delete_failed",
          retryable: false,
          data: {
            kind: "blob.delete",
            status: "not_applied",
            workspaceId,
            key,
            permanently,
            deleted: false,
          },
        });
      }

      return receipt("blob.delete", {
        status: "deleted",
        key,
        workspaceId,
        permanently,
        deleted: true,
        success: true,
      });
    } catch (error: any) {
      return toolError(error, {
        code: "blob_delete_failed",
        retryable: false,
        data: {
          kind: "blob.delete",
          status: "failed",
          key,
          workspaceId,
          permanently,
          deleted: false,
        },
      });
    }
  };
  server.registerTool(
    "delete_blob",
    {
      title: "Delete Blob",
      description: "Delete a blob from AFFiNE workspace storage. Set permanently only when the blob should bypass recoverable deletion.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id that owns the blob."),
        key: z.string().describe("Blob key returned by upload_blob or AFFiNE document metadata."),
        permanently: z.boolean().optional().describe("If true, permanently delete the blob instead of marking it deleted."),
        confirmKey: z.string().optional().describe("Required when permanently=true and must exactly match key.")
      }
    },
    deleteBlobHandler as any
  );

  // RELEASE DELETED BLOBS
  const cleanupBlobsHandler = async ({ workspaceId, confirmWorkspaceId }: { workspaceId: string; confirmWorkspaceId?: string }) => {
    try {
      requireMatchingConfirmation("cleanup_blobs", workspaceId, confirmWorkspaceId);
      const mutation = `
        mutation ReleaseDeletedBlobs($workspaceId: String!) {
          releaseDeletedBlobs(workspaceId: $workspaceId)
        }
      `;
      
      const data = await gql.request<{ releaseDeletedBlobs: boolean }>(mutation, {
        workspaceId
      });

      if (!data.releaseDeletedBlobs) {
        return toolError("AFFiNE did not confirm deleted blob cleanup.", {
          code: "blob_cleanup_failed",
          retryable: false,
          data: {
            kind: "blob.cleanup",
            status: "not_applied",
            workspaceId,
            blobsReleased: false,
          },
        });
      }

      return receipt("blob.cleanup", {
        status: "completed",
        workspaceId,
        blobsReleased: true,
        success: true,
      });
    } catch (error: any) {
      return toolError(error, {
        code: "blob_cleanup_failed",
        retryable: false,
        data: {
          kind: "blob.cleanup",
          status: "failed",
          workspaceId,
          blobsReleased: false,
        },
      });
    }
  };
  server.registerTool(
    "cleanup_blobs",
    {
      title: "Cleanup Deleted Blobs",
      description: "Permanently release blobs that were already marked deleted in a workspace. This is destructive cleanup and should be used only after confirming deleted blobs are no longer needed.",
      inputSchema: {
        workspaceId: z.string().describe("AFFiNE workspace id whose deleted blobs should be released."),
        confirmWorkspaceId: z.string().describe("Must exactly match workspaceId to confirm permanent blob cleanup.")
      }
    },
    cleanupBlobsHandler as any
  );
}
