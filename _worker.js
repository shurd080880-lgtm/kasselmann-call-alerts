const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=UTF-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-alert-key",
    "access-control-allow-methods": "POST, OPTIONS"
  }
});

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function clean(value, fallback = "Not provided") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const LEGACY_TAGS = [
  "call_alerts_enabled",
  "registered_location",
  "call_office_regulatory",
  "call_office_media_inquiry",
  "call_office_customer_complaint",
  "call_office_food_safety",
  "call_office_vendor_service_request",
  "call_office_vendor_unpaid_invoice_payment",
  "call_office_vendor_other",
  "call_office_donation_request",
  "call_office_loan_request",
  "call_office_employment",
  "call_office_legal_attorney",
  "call_office_general_message",
  "call_office_emergency"
];

const CALL_TYPE_BITS = {
  "customer_complaint": 0,
  "food_safety": 1,
  "vendor_service_request": 2,
  "vendor_unpaid_invoice_payment": 2,
  "vendor_other": 2,
  "donation_request": 3,
  "loan_request": 4,
  "employment": 5,
  "legal_attorney": 6,
  "general_message": 7,
  "emergency": 8
};

function userEndpoint(env, externalId) {
  return `https://api.onesignal.com/apps/${encodeURIComponent(env.ONESIGNAL_APP_ID)}/users/by/external_id/${encodeURIComponent(externalId)}`;
}

async function patchUserTags(env, externalId, tags) {
  const response = await fetch(userEndpoint(env, externalId), {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "authorization": `Key ${env.ONESIGNAL_API_KEY}`
    },
    body: JSON.stringify({ properties: { tags } })
  });
  return { response, data: await parseResponse(response) };
}

async function handleRegister(request, env) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY) {
    return json({ ok: false, error: "OneSignal secrets are not configured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const externalId = String(body.externalId || "").trim();
  const tags = body.tags && typeof body.tags === "object" && !Array.isArray(body.tags)
    ? body.tags
    : null;

  if (!externalId || !externalId.startsWith("kasselmann_device_")) {
    return json({ ok: false, error: "Invalid device external ID" }, 400);
  }
  if (!tags) return json({ ok: false, error: "Tags are required" }, 400);

  const allowedTags = {
    registered_name: String(tags.registered_name || "").trim(),
    registered_phone: String(tags.registered_phone || "").trim(),
    registered_device_id: externalId,
    alert_mask: String(tags.alert_mask || "0").trim(),
    registered_at: String(tags.registered_at || new Date().toISOString()).trim()
  };

  if (!/^\d+$/.test(allowedTags.alert_mask) || Number(allowedTags.alert_mask) < 0 || Number(allowedTags.alert_mask) > 511) {
    return json({ ok: false, error: "Invalid alert preference mask" }, 400);
  }

  try {
    const cleanup = Object.fromEntries(LEGACY_TAGS.map(k => [k, ""]));
    const cleanupResult = await patchUserTags(env, externalId, cleanup);
    if (!cleanupResult.response.ok) {
      return json({
        ok: false,
        error: "OneSignal rejected legacy tag cleanup",
        status: cleanupResult.response.status,
        oneSignal: cleanupResult.data
      }, 502);
    }

    const updateResult = await patchUserTags(env, externalId, allowedTags);
    if (!updateResult.response.ok) {
      return json({
        ok: false,
        error: "OneSignal rejected compact tag update",
        status: updateResult.response.status,
        oneSignal: updateResult.data
      }, 502);
    }
  } catch (error) {
    return json({ ok: false, error: "Unable to reach OneSignal user API", detail: String(error) }, 502);
  }

  let verifyResponse;
  try {
    verifyResponse = await fetch(userEndpoint(env, externalId), {
      method: "GET",
      headers: { "authorization": `Key ${env.ONESIGNAL_API_KEY}` }
    });
  } catch (error) {
    return json({ ok: false, error: "Tags updated but verification failed", detail: String(error) }, 502);
  }

  const verifyData = await parseResponse(verifyResponse);
  if (!verifyResponse.ok) {
    return json({ ok: false, error: "OneSignal verification failed", status: verifyResponse.status, oneSignal: verifyData }, 502);
  }

  const verifiedTags = verifyData?.properties?.tags || {};
  const mismatches = Object.keys(allowedTags).filter(
    key => String(verifiedTags[key] ?? "") !== String(allowedTags[key])
  );

  if (mismatches.length) {
    return json({ ok: false, error: "OneSignal compact tag verification mismatch", mismatches, verifiedTags }, 502);
  }

  return json({
    ok: true,
    externalId,
    verifiedTags,
    subscriptions: Array.isArray(verifyData?.subscriptions)
      ? verifyData.subscriptions.map(s => ({ id: s.id, type: s.type, enabled: s.enabled }))
      : []
  });
}

function maskFiltersForBit(bit) {
  const values = [];
  for (let mask = 1; mask <= 511; mask++) {
    if ((mask & (1 << bit)) !== 0) values.push(String(mask));
  }
  return values;
}

function makeFilterBatch(values) {
  const filters = [];
  values.forEach((value, i) => {
    if (i) filters.push({ operator: "OR" });
    filters.push({ field: "tag", key: "alert_mask", relation: "=", value });
  });
  return filters;
}

async function sendNotificationBatch(env, basePayload, filters) {
  const response = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Key ${env.ONESIGNAL_API_KEY}`
    },
    body: JSON.stringify({ ...basePayload, filters })
  });
  return { status: response.status, ok: response.ok, data: await parseResponse(response) };
}

async function handleAlert(request, env) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY) {
    return json({ ok: false, error: "OneSignal secrets are not configured" }, 500);
  }

  if (env.ALERT_API_KEY) {
    const supplied = request.headers.get("x-alert-key") || "";
    if (supplied !== env.ALERT_API_KEY) return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const callType = clean(body.callType, "General Message");
  const location = clean(body.location, "Office");
  const callerName = clean(body.callerName, "Unknown caller");
  const phone = clean(body.phone);
  const summary = clean(body.summary, "No summary provided");
  const priority = clean(body.priority, "Normal");
  const callTypeSlug = slug(callType);
  const bit = CALL_TYPE_BITS[callTypeSlug] ?? CALL_TYPE_BITS.general_message;
  const title = `${callType} - ${location}`;
  const message = `${callerName} | ${phone}\n${summary}`;

  const basePayload = {
    app_id: env.ONESIGNAL_APP_ID,
    headings: { en: title },
    contents: { en: message },
    data: { callType, location, callerName, phone, summary, priority, alertBit: bit }
  };

  const matchingMasks = maskFiltersForBit(bit);
  const batches = [];
  for (let i = 0; i < matchingMasks.length; i += 100) {
    batches.push(matchingMasks.slice(i, i + 100));
  }

  const results = [];
  try {
    for (const batch of batches) {
      results.push(await sendNotificationBatch(env, basePayload, makeFilterBatch(batch)));
    }
  } catch (error) {
    return json({ ok: false, error: "Unable to reach OneSignal", detail: String(error) }, 502);
  }

  const successful = results.filter(r => r.ok && r.data && r.data.id);
  if (!successful.length) {
    return json({
      ok: false,
      error: "OneSignal did not create a notification for any matching alert-mask batch",
      alertBit: bit,
      oneSignal: results.map(r => ({ status: r.status, data: r.data }))
    }, 502);
  }

  const recipients = successful.reduce((sum, r) => sum + (Number(r.data.recipients) || 0), 0);
  return json({
    ok: true,
    alertBit: bit,
    notificationIds: successful.map(r => r.data.id),
    recipients,
    batchesSent: results.length
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization, x-alert-key",
          "access-control-allow-methods": "POST, OPTIONS"
        }
      });
    }

    if (url.pathname === "/api/register") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleRegister(request, env);
    }

    if (url.pathname === "/api/alert") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleAlert(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
