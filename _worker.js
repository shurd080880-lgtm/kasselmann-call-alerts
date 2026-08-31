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

    if (url.pathname !== "/api/alert") {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

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

    const responseText = await oneSignalResponse.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    if (!oneSignalResponse.ok) {
      return json({
        ok: false,
        error: "OneSignal rejected the notification",
        status: oneSignalResponse.status,
        tagKey,
        oneSignal: responseData
      }, 502);
    }

    // OneSignal can return HTTP 200 with no notification ID when the
    // request was accepted but no eligible subscription matched.
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
};
