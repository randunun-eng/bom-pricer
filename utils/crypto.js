export async function verifySignature(payloadStr, signature, secret) {
    if (!signature || !secret) return false;

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
        "raw", keyData, { name: "HMAC", hash: "SHA-256" },
        false, ["verify"]
    );

    const data = encoder.encode(payloadStr);
    const signatureBytes = Uint8Array.from(signature.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

    return await crypto.subtle.verify("HMAC", key, signatureBytes, data);
}

export async function signPayload(payloadStr, secret) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
        "raw", keyData, { name: "HMAC", hash: "SHA-256" },
        false, ["sign"]
    );

    const data = encoder.encode(payloadStr);
    const signature = await crypto.subtle.sign("HMAC", key, data);

    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
