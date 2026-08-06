const GLOSSARY_EXTENSIONS = new Set([".csv", ".xlsx"]);

function requireObject(value, label) {
  if (!value || typeof value !== "object") {
    throw new TypeError(label + " must be an object");
  }
  return value;
}

export function endpointGrantPresentation(grantValue, baseHref) {
  const grant = requireObject(grantValue, "Endpoint grant");
  const side = grant.side === "A" || grant.side === "B" ? grant.side : null;
  if (!side) throw new TypeError("Endpoint grant side must be A or B");

  if (grant.kind === "browser_link") {
    if (typeof grant.url !== "string" || grant.url.length === 0) {
      throw new TypeError("Browser endpoint grant requires a URL");
    }
    const href = new URL(grant.url, baseHref).toString();
    return Object.freeze({
      kind: grant.kind,
      side,
      href,
      copyValue: href,
      ...(typeof grant.qrDataUrl === "string" && grant.qrDataUrl.length > 0
        ? { qrDataUrl: grant.qrDataUrl }
        : {}),
    });
  }

  if (grant.kind === "telephony_test") {
    if (typeof grant.address !== "string" || grant.address.length === 0) {
      throw new TypeError("Telephony test endpoint grant requires an address");
    }
    return Object.freeze({
      kind: grant.kind,
      side,
      address: grant.address,
      copyValue: grant.address,
    });
  }

  throw new TypeError("Unsupported endpoint grant kind");
}

export function arrayBufferToBase64(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError("Glossary contents must be an ArrayBuffer");
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function glossaryUploadContents(fileName, buffer) {
  if (typeof fileName !== "string" || fileName.trim().length === 0) {
    throw new TypeError("Glossary filename is required");
  }
  const normalized = fileName.trim();
  const dot = normalized.lastIndexOf(".");
  const extension = dot < 0 ? "" : normalized.slice(dot).toLowerCase();
  if (!GLOSSARY_EXTENSIONS.has(extension)) {
    throw new TypeError("Glossary file must be CSV or XLSX");
  }
  return Object.freeze({
    fileName: normalized,
    contentsBase64: arrayBufferToBase64(buffer),
  });
}
