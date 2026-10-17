/** In-memory adaptation of the verified CLI to Desktop's business-token store. */
import { ZCODE_PROJECT_ACCESS_PREFIX } from "./projectAccessDiagnostic.ts";
export const ZCODE_DESKTOP_BUNDLE_SHA256 = "31965ce1d5d4a808ef156784f67996de42ccab335591d2386a61ea8f6f506a54";
export const ZCODE_DESKTOP_AUTH_REJECTED = "agent-broker:zcode-desktop-auth-rejected:401";
export const ZCODE_DESKTOP_AUTH_REQUEST = "agent-broker:zcode-desktop-auth-request";
export const ZCODE_DESKTOP_INCOMPATIBLE = "ZCode Desktop authentication needs revalidation for this CLI bundle.";

/** Called only after checking the complete bundle hash, in the native child. */
export function adaptDesktopAuthSource(source: string): string {
  if (source.split("function fpt(e){").length !== 2) throw new Error(ZCODE_DESKTOP_INCOMPATIBLE);
  const start = source.indexOf("function fpt(e){");
  const end = source.indexOf("async function Ita(", start);
  if (start < 0 || end < start) throw new Error(ZCODE_DESKTOP_INCOMPATIBLE);
  let resolver = source.slice(start, end);
  const replaceOnce = (before: string, after: string) => {
    if (resolver.split(before).length !== 2) throw new Error(ZCODE_DESKTOP_INCOMPATIBLE);
    resolver = resolver.replace(before, after);
  };
  // Desktop already performed this exchange before saving oauth:zai:access_token.
  // Keep the native cache, expiry checks, project discovery and PAT issuance.
  replaceOnce('()=>o(`${Iso}/api/auth/z/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:g})})',
    '()=>Promise.resolve({code:200,data:{access_token:g}})');
  const stage = 'new URL(f).origin!==Iso?null:new URL(f).pathname==="/api/biz/customer/getCustomerInfo"?"customer_info":new URL(f).pathname.endsWith("/access_tokens")?"pat_issue":new URL(f).pathname.endsWith("/api_keys")?(g.method==="POST"?"key_create":"key_list"):null';
  replaceOnce('o=r(async(f,g)=>{let _=await e.httpClient.request(',
    `o=r(async(f,g)=>{const __abStage=${stage};const __abEmit=(kind,status,vendor_code)=>{if(__abStage)process.stderr.write(${JSON.stringify(ZCODE_PROJECT_ACCESS_PREFIX)}+JSON.stringify({stage:__abStage,kind,...status===undefined?{}:{status},...vendor_code===undefined?{}:{vendor_code}})+"\\n")};if(__abStage)process.stderr.write(${JSON.stringify(ZCODE_DESKTOP_AUTH_REQUEST + "\n")});let _=await e.httpClient.request(`);
  replaceOnce('.catch(b=>{throw T7(b)', '.catch(b=>{__abEmit(b?.code==="timeout"?"timeout":b?.code==="network_error"?"network_error":"request_error");throw T7(b)');
  // Observe the native auth resolver, independently of fetch/proxy/HTTPS transport.
  // A recovered 401 does not fail a completed turn. No credential data is printed.
  const rejected = 'if(_.status===401&&new URL(f).pathname.startsWith("/api/biz/"))';
  replaceOnce(rejected, `if(_.status<200||_.status>=300)__abEmit("http",_.status);if(_.status===401&&new URL(f).origin===Iso&&new URL(f).pathname.startsWith("/api/biz/"))process.stderr.write(${JSON.stringify(ZCODE_DESKTOP_AUTH_REJECTED + "\n")});${rejected}`);
  replaceOnce('return JSON.parse(new TextDecoder().decode(_.body))', 'try{const __abBody=JSON.parse(new TextDecoder().decode(_.body));const __abCode=typeof __abBody?.code==="number"?__abBody.code:typeof __abBody?.code==="string"&&/^\\d{1,8}$/.test(__abBody.code)?Number(__abBody.code):undefined;if(__abCode!==undefined&&__abCode!==0&&__abCode!==200)__abEmit("provider_error",_.status,__abCode);return __abBody}catch(__abError){__abEmit("invalid_json",_.status);throw __abError}');
  return source.slice(0, start) + resolver + source.slice(end);
}
