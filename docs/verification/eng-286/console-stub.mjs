// ENG-286 local console stub: answers the broker's tenant-provisioning key
// validation exactly like console.vendo.run would, for ONE made-up local key.
// Local throwaway; never deployed.
import http from "node:http";

const LOCAL_TEST_KEY = `vnd_${"ab".repeat(20)}`; // "vnd_local_test" stand-in, matches ^vnd_[0-9a-f]{40}$
const ORG = {
  id: "00000000-0000-4000-8000-0000000000aa",
  name: "Local Test Org",
  slug: "local-test-org",
};

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  if (req.method === "POST" && req.url === "/api/v1/keys/validate") {
    if (auth === `Bearer ${LOCAL_TEST_KEY}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ valid: true, org: ORG }));
    } else {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ valid: false }));
    }
    console.log(`[console-stub] ${req.method} ${req.url} -> ${res.statusCode}`);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(4390, "127.0.0.1", () => console.log("[console-stub] listening on 127.0.0.1:4390"));
