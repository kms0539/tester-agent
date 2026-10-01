// Forge 로컬 API를 화면과 같은 방식(같은 Origin, JSON 본문)으로 부른다.

const APP_ORIGIN = "http://127.0.0.1:3200";

export class ForgeApiError extends Error {
  constructor(path, status, data) {
    super(`${path} → ${status} ${data?.code ?? ""} ${data?.error ?? ""}`.replace(/\s+/g, " ").trim());
    this.path = path;
    this.status = status;
    this.code = data?.code ?? null;
    this.data = data;
  }
}

export function createForgeApi({ baseUrl }) {
  async function post(path, body = {}) {
    const response = await fetch(baseUrl + path, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ForgeApiError(path, response.status, data);
    return data;
  }

  async function health() {
    const response = await fetch(baseUrl + "/health");
    return response.json();
  }

  return { baseUrl, post, health };
}
