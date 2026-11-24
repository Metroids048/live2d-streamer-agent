export const LOCAL_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
export const SDK_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function attachmentLimitForRevision(job) {
  // This checkpoint is only registered by the original-session refined replay gate.
  return /^[a-f0-9]{64}$/.test(job.cachedReplay?.refinedArtworkSha256 ?? '')
    ? 256 * 1024 * 1024
    : LOCAL_ATTACHMENT_MAX_BYTES;
}

/** Service cap must come from an actual service/download verification, never SDK inference. */
export function planDelivery(files, {localMaxBytes = LOCAL_ATTACHMENT_MAX_BYTES, serviceMaxBytes = null} = {}) {
  if (!Number.isSafeInteger(localMaxBytes) || localMaxBytes <= 0 ||
      serviceMaxBytes !== null && (!Number.isSafeInteger(serviceMaxBytes) || serviceMaxBytes <= 0)) throw new TypeError('Invalid attachment limit');
  const planned = files.map(file => {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new TypeError('Invalid attachment bytes');
    const localAllowed = file.bytes <= localMaxBytes;
    const serviceAllowed = serviceMaxBytes === null ? null : file.bytes <= serviceMaxBytes;
    return {...file, localAllowed, serviceAllowed,
      status: !localAllowed || serviceAllowed === false ? 'blocked' : serviceAllowed === null ? 'unverified' : 'eligible',
      sdkMaxBytesRequired: file.bytes > SDK_DEFAULT_MAX_BYTES ? file.bytes : null,
      published: 'not_run', cardVisible: 'not_run', downloadVerified: 'not_run'};
  });
  return {localMaxBytes, sdkDefaultMaxBytes: SDK_DEFAULT_MAX_BYTES, serviceMaxBytes,
    files: planned, nativeDelivery: 'not_run',
    note: 'SDK maxBytes 仅为调用方校验参数；eligible 也不代表服务发布或客户端下载通过。'};
}
