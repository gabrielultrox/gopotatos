const IFOOD_BASE_URL = "https://merchant-api.ifood.com.br";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

function send(res, statusCode, data) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

async function requestIfoodToken() {
  const clientId = process.env.IFOOD_CLIENT_ID;
  const clientSecret = process.env.IFOOD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const error = new Error("Missing iFood credentials");
    error.statusCode = 500;
    throw error;
  }

  const body = new URLSearchParams({
    grantType: "client_credentials",
    clientId,
    clientSecret,
  });

  const response = await fetch(`${IFOOD_BASE_URL}/authentication/v1.0/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "Could not authenticate with iFood");
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  return data.accessToken || data.access_token;
}

async function callIfood(path, options = {}) {
  const token = await requestIfoodToken();
  const response = await fetch(`${IFOOD_BASE_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...JSON_HEADERS,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(data?.message || "iFood API request failed");
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

async function handleGet(req, res, route) {
  if (route === "health") {
    send(res, 200, {
      ok: true,
      configured: Boolean(process.env.IFOOD_CLIENT_ID && process.env.IFOOD_CLIENT_SECRET),
    });
    return;
  }

  if (route === "events") {
    const events = await callIfood("/order/v1.0/events:polling");
    send(res, 200, { events: events || [] });
    return;
  }

  if (route.startsWith("orders/")) {
    const orderId = route.split("/")[1];
    const order = await callIfood(`/order/v1.0/orders/${encodeURIComponent(orderId)}`);
    send(res, 200, { order });
    return;
  }

  send(res, 404, { error: "Route not found" });
}

async function handlePost(req, res, route) {
  const body = await readBody(req);

  if (route === "events/acknowledgment") {
    const events = Array.isArray(body.events) ? body.events : [];
    const payload = events.map((event) => ({
      id: event.id,
    }));

    const result = await callIfood("/order/v1.0/events/acknowledgment", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    send(res, 200, { result });
    return;
  }

  const actionMatch = route.match(/^orders\/([^/]+)\/(confirm|dispatch|ready-to-pickup|cancel)$/);

  if (actionMatch) {
    const [, orderId, action] = actionMatch;
    const actionPaths = {
      confirm: "confirm",
      dispatch: "dispatch",
      "ready-to-pickup": "readyToPickup",
      cancel: "requestCancellation",
    };

    const result = await callIfood(
      `/order/v1.0/orders/${encodeURIComponent(orderId)}/${actionPaths[action]}`,
      {
        method: "POST",
        body: JSON.stringify(body || {}),
      },
    );

    send(res, 200, { result });
    return;
  }

  send(res, 404, { error: "Route not found" });
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const route = (url.searchParams.get("route") || "health").replace(/^\/+/, "");

  try {
    if (req.method === "GET") {
      await handleGet(req, res, route);
      return;
    }

    if (req.method === "POST") {
      await handlePost(req, res, route);
      return;
    }

    send(res, 405, { error: "Method not allowed" });
  } catch (error) {
    send(res, error.statusCode || 500, {
      error: error.message,
      details: error.details || null,
    });
  }
};
