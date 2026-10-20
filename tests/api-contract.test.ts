import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv, type AnySchemaObject } from "ajv";
import addFormats from "ajv-formats";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import contract from "../api/openapi.json";
import { GET } from "../src/app/api/health/route.ts";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/server/database.ts", () => ({ getPool: () => ({ query }) }));

type Media = { schema: AnySchemaObject; example: unknown };
type Operation = {
  requestBody?: { content: Record<string, Media> };
  parameters?: { schema: AnySchemaObject; example?: unknown }[];
  responses: Record<string, { content?: Record<string, Media> }>;
};
let paths: Record<string, Record<string, Operation>>;
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

beforeAll(async () => {
  const api = await SwaggerParser.validate("api/openapi.json", { resolve: { external: false } });
  paths = api.paths as unknown as typeof paths;
});

function expectValid(schema: AnySchemaObject, data: unknown) {
  const validate = ajv.compile(schema);
  expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
}

async function expectContractResponse(response: Response) {
  const media = paths["/api/health"].get.responses[response.status].content!["application/json"];
  const body: unknown = await response.json();
  expectValid(media.schema, body);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  return body;
}

describe("OpenAPI contract", () => {
  it("validates every documented request, header and response example", () => {
    for (const path of Object.values(paths)) {
      for (const operation of Object.values(path)) {
        for (const media of Object.values(operation.requestBody?.content ?? {})) {
          expectValid(media.schema, media.example);
        }
        for (const parameter of operation.parameters ?? []) {
          if (parameter.example !== undefined) expectValid(parameter.schema, parameter.example);
        }
        for (const response of Object.values(operation.responses)) {
          for (const media of Object.values(response.content ?? {})) {
            expectValid(media.schema, media.example);
          }
        }
      }
    }
  });

  it.each([0, -1, 2, 1.5, "1", null])("rejects invalid booking quantity %s", (quantity) => {
    const validate = ajv.compile(contract.components.schemas.ReservationRequest);
    expect(validate({ eventId: "live-sessions-demo", quantity })).toBe(false);
  });

  it("rejects missing fields and client-supplied ownership", () => {
    const validate = ajv.compile(contract.components.schemas.ReservationRequest);
    expect(validate({ eventId: "live-sessions-demo" })).toBe(false);
    expect(validate({ eventId: "live-sessions-demo", quantity: 1, owner: "another-owner" })).toBe(false);
    expect(validate({ eventId: "live-sessions-demo", quantity: 1, sessionToken: "another-token" })).toBe(false);
  });
});

describe("implemented health route", () => {
  beforeEach(() => { query.mockReset(); });

  it("returns the documented ready response after querying the database", async () => {
    query.mockResolvedValue({ rows: [] });
    const response = await GET(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
    await expectContractResponse(response);
    expect(query).toHaveBeenCalledOnce();
  });

  it("returns the documented unavailable response without leaking driver errors", async () => {
    query.mockRejectedValue(new Error("postgresql://private:secret@internal/database"));
    const response = await GET(new Request("http://localhost/api/health"));
    expect(response.status).toBe(503);
    const body = await expectContractResponse(response);
    expect(body).toEqual({ status: "unavailable", database: "unavailable" });
  });

  it("rejects unsupported input before accessing the database and does not echo it", async () => {
    const response = await GET(new Request("http://localhost/api/health?owner=private-secret"));
    expect(response.status).toBe(400);
    expect(await expectContractResponse(response)).toEqual({
      error: { code: "INVALID_REQUEST", message: "This endpoint does not accept query parameters." },
    });
    expect(query).not.toHaveBeenCalled();
  });
});
