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

  if (!tags) {
    return json({ ok: false, error: "Tags are required" }, 400);
  }

  const allowedTags = {};
  for (const [key, value] of Object.entries(tags)) {
    if (
      key === "call_alerts_enabled" ||
      key === "registered_name" ||
      key === "registered_phone" ||
      key === "registered_device_id" ||
      key === "registered_location" ||
      key === "registered_at" ||
      key.startsWith("call_office_")
    ) {
      allowedTags[key] = String(value ?? "");
    }
  }

  const endpoint = `https://api.onesignal.com/apps/${encodeURIComponent(env.ONESIGNAL_APP_ID)}/users/by/external_id/${encodeURIComponent(externalId)}`;

  let updateResponse;
  try {
    updateResponse = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "authorization": `Key ${env.ONESIGNAL_API_KEY}`
      },
      body: JSON.stringify({
        properties: {
          tags: allowedTags
        }
      })
    });
  } catch (error) {
    return json({ ok: false, error: "Unable to reach OneSignal user API", detail: String(error) }, 502);
  }

  const updateData = await parseResponse(updateResponse);
  if (!updateResponse.ok) {
    return json({
      ok: false,
      error: "OneSignal rejected the user tag update",
      status: updateResponse.status,
      oneSignal: updateData
    }, 502);
  }

  let verifyResponse;
  try {
    verifyResponse = await fetch(endpoint, {
      method: "GET",
      headers: {
        "authorization": `Key ${env.ONESIGNAL_API_KEY}`
      }
    });
  } catch (error) {
    return json({ ok: false, error: "Tags updated but verification failed", detail: String(error) }, 502);
  }

  const verifyData = await parseResponse(verifyResponse);
  if (!verifyResponse.ok) {
    return json({
      ok: false,
      error: "Tags updated but OneSignal verification failed",
      status: verifyResponse.status,
      oneSignal: verifyData
    }, 502);
  }

  const verifiedTags = verifyData?.properties?.tags || {};
  const requiredTagKeys = Object.keys(allowedTags);
  const mismatches = requiredTagKeys.filter(key => String(verifiedTags[key] ?? "") !== String(allowedTags[key]));

  if (mismatches.length) {
    return json({
      ok: false,
      error: "OneSignal tag verification mismatch",
      mismatches,
      verifiedTags
    }, 502);
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

async function handleAlert(request, env) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_API_KEY) {
    return json({ ok: false, error: "OneSignal secrets are not configured" }, 500);
  }

  if (env.ALERT_API_KEY) {
    const supplied = request.headers.get("x-alert-key") || "";
    if (supplied !== env.ALERT_API_KEY) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
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

  const tagKey = `call_${slug(location)}_${slug(callType)}`;
  const title = `${callType} - ${location}`;
  const message = `${callerName} | ${phone}\n${summary}`;

  const oneSignalPayload = {
    app_id: env.ONESIGNAL_APP_ID,
    headings: { en: title },
    contents: { en: message },
    filters: [
      {
        field: "tag",
        key: tagKey,
        relation: "=",
        value: "1"
      }
    ],
    data: {
      callType,
      location,
      callerName,
      phone,
      summary,
      priority,
      tagKey
    }
  };

  let oneSignalResponse;
  try {
    oneSignalResponse = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Key ${env.ONESIGNAL_API_KEY}`
      },
      body: JSON.stringify(oneSignalPayload)
    });
  } catch (error) {
    return json({ ok: false, error: "Unable to reach OneSignal", detail: String(error) }, 502);
  }

  const responseData = await parseResponse(oneSignalResponse);

  if (!oneSignalResponse.ok) {
    return json({
      ok: false,
      error: "OneSignal rejected the notification",
      status: oneSignalResponse.status,
      tagKey,
      oneSignal: responseData
    }, 502);
  }

  if (!responseData.id) {
    return json({
      ok: false,
      error: "OneSignal did not create a notification",
      status: oneSignalResponse.status,
      tagKey,
      notificationId: null,
      recipients: responseData.recipients ?? null,
      oneSignal: responseData
    }, 502);
  }

  return json({
    ok: true,
    tagKey,
    notificationId: responseData.id,
    recipients: responseData.recipients ?? null,
    oneSignal: responseData
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
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }
      return handleRegister(request, env);
    }

    if (url.pathname === "/api/alert") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }
      return handleAlert(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
