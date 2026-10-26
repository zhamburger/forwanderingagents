import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { POST as mcp } from "../app/api/mcp/route";
import { POST as http } from "../app/api/messages/route";
import { GET as results } from "../app/api/results/route";
import { buildParticipationEvent, persistParticipation } from "../lib/participation-log";
import { clearResultsCache } from "../lib/experiment-results";
import { submissionSchema } from "../lib/experiment";

const originalEnv = { ...process.env };
const valid = { agent_name: "Verification agent", message: "A clearly marked verification submission.", instructed_to_visit: true, is_test: true };
function request(body: unknown, extra: Record<string,string> = {}) {
  return new Request("https://forwanderingagents.com/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", "x-vercel-forwarded-for": "192.0.2.91", ...extra }, body: JSON.stringify(body) });
}
function call(input: unknown = valid) { return { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "submit_guestbook_message", arguments: input } }; }
beforeEach(() => {
  Object.assign(process.env, { SUPABASE_URL: "https://test.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-secret", GUESTBOOK_HASH_SALT: "test-only-salt-with-at-least-32-characters", GUESTBOOK_POSTING_ENABLED: "true", VERCEL: "1", VERCEL_ENV: "production", VISIT_LOGGING_ENABLED: "false" });
  clearResultsCache();
});
afterEach(() => { process.env = { ...originalEnv }; });

test("MCP and HTTP queue through the same quota RPC and preserve test provenance", async t => {
  const bodies: Record<string,unknown>[] = [];
  t.mock.method(globalThis,"fetch",async (url: string, init: RequestInit) => {
    assert.equal(url,"https://test.supabase.co/rest/v1/rpc/submit_agent_message_v2");
    bodies.push(JSON.parse(init.body as string));
    return Response.json(43);
  });
  const rpc = await (await mcp(request(call()))).json();
  assert.equal(rpc.result.isError,false);
  assert.equal(JSON.parse(rpc.result.content[0].text).status,"pending");
  assert.equal((await http(request(valid))).status,202);
  assert.deepEqual(bodies.map(b=>b.p_submission_channel),["mcp","http"]);
  assert.equal(bodies[0].p_submitter_hash,bodies[1].p_submitter_hash);
  assert.equal(bodies[0].p_is_test,true);
  assert.equal(bodies[0].p_instructed_to_visit,true);
  assert.ok(!("status" in bodies[0]));
});

test("MCP rejects unsafe fields, invalid Unicode, and invalid argument types without writes", async t => {
  const spy=t.mock.method(globalThis,"fetch",async()=>{throw new Error("Unexpected write");});
  for(const input of [{...valid,status:"approved"},{...valid,is_test:"true"},{...valid,message:"short"},{...valid,agent_name:"bad\u0000name"},{...valid,discovery_route:"fake"},[],null]) {
    const value=await (await mcp(request(call(input)))).json();
    assert.ok(value.error || value.result.isError);
  }
  assert.equal(spy.mock.callCount(),0);
});

test("MCP submission notifications never execute a write",async t=>{
  const spy=t.mock.method(globalThis,"fetch",async()=>{throw new Error("Unexpected write");});
  const body=call();
  const response=await mcp(request({...body,id:undefined}));
  assert.equal(response.status,202);
  assert.equal(await response.text(),"");
  assert.equal(spy.mock.callCount(),0);
});

test("MCP previews and missing trusted addresses cannot submit",async t=>{
  const spy=t.mock.method(globalThis,"fetch",async()=>{throw new Error("Unexpected write");});
  process.env.VERCEL_ENV="preview";
  let value=await (await mcp(request(call()))).json();
  assert.equal(value.result.isError,true);
  process.env.VERCEL_ENV="production";
  value=await (await mcp(request(call(),{"x-vercel-forwarded-for":""}))).json();
  assert.equal(value.result.isError,true);
  assert.equal(spy.mock.callCount(),0);
});

test("MCP enforces bounded JSON bodies and rejects untrusted browser origins",async()=>{
  assert.equal((await mcp(request({jsonrpc:"2.0",id:1,method:"ping",padding:"x".repeat(10000)}))).status,413);
  assert.equal((await mcp(request(call(),{"Content-Type":"text/plain"}))).status,415);
  assert.equal((await mcp(request(call(),{"Content-Encoding":"gzip"}))).status,415);
  assert.equal((await mcp(request(call(),{origin:"https://untrusted.example"}))).status,403);
  assert.equal((await mcp(request({jsonrpc:"2.0",id:{private:"value"},method:"ping"}))).status,400);
});

test("MCP exposes write annotations and a schema consistent with HTTP",async()=>{
  const value=await (await mcp(request({jsonrpc:"2.0",id:1,method:"tools/list"}))).json();
  const tool=value.result.tools.find((item:{name:string})=>item.name==="submit_guestbook_message");
  assert.deepEqual(tool.annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true});
  assert.deepEqual(tool.inputSchema,submissionSchema);
  const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
  const schema=api.paths['/api/messages'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(Object.keys(schema.properties).sort(),Object.keys(submissionSchema.properties).sort());
  assert.deepEqual(schema.required,submissionSchema.required);
  assert.equal(value.result.tools.length,4);
});

test("MCP reports quota failures and hides backend errors",async t=>{
  let failure="rate limit exceeded";
  t.mock.method(globalThis,"fetch",async()=>new Response(failure,{status:400}));
  let value=await (await mcp(request(call()))).json();
  assert.equal(value.result.isError,true);
  assert.equal(JSON.parse(value.result.content[0].text).http_status,429);
  failure="PRIVATE BACKEND ERROR test-secret";
  value=await (await mcp(request(call()))).json();
  assert.equal(value.result.isError,true);
  assert.equal(JSON.parse(value.result.content[0].text).http_status,503);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE|test-secret/);
});

test("participation telemetry cannot record arbitrary tool labels, arguments or identifiers",()=>{
  const event=buildParticipationEvent(request(call(),{cookie:"private-cookie",referer:"https://example.test/?secret=private", "user-agent":"Owner-authorized-verification/1.0"}),{
    transport:"mcp",rpc_method:"tools/call",tool_name:"private tool payload",http_status:200,outcome:"unknown_tool",
  })!;
  assert.equal(event.tool_name,"unknown");
  assert.equal(event.is_test,true);
  assert.doesNotMatch(JSON.stringify(event),/private|192\.0\.2|Verification agent/);
  assert.deepEqual(Object.keys(event).sort(),["experiment_phase","http_status","is_test","outcome","rpc_method","tool_name","transport","visitor_hash"]);
});

test("telemetry persists only the safe event and database failures do not escape",async t=>{
  const event=buildParticipationEvent(request(call()),{transport:"mcp",rpc_method:"tools/call",tool_name:"submit_guestbook_message",http_status:200,outcome:"accepted_pending",is_test:true})!;
  t.mock.method(console,"warn",()=>{});
  t.mock.method(globalThis,"fetch",async(url:string,init:RequestInit)=>{
    assert.equal(url,"https://test.supabase.co/rest/v1/participation_events");
    assert.deepEqual(JSON.parse(init.body as string),event);
    throw new Error("PRIVATE failure");
  });
  await persistParticipation(event);
});

test("results use the aggregate RPC, share cached reads, and surface outages without fake zeroes",async t=>{
  let calls=0;
  let fail=true;
  t.mock.method(globalThis,"fetch",async(url:string)=>{
    assert.equal(url,"https://test.supabase.co/rest/v1/rpc/get_experiment_results");
    calls++;
    return fail ? new Response("PRIVATE test-secret",{status:500}) : Response.json({traffic:{requests:123}});
  });
  const bad=await results();
  assert.equal(bad.status,503);
  assert.doesNotMatch(await bad.text(),/PRIVATE|test-secret/);
  fail=false;
  assert.equal((await (await results()).json()).traffic.requests,123);
  assert.equal((await results()).status,200);
  assert.equal(calls,2);
});
