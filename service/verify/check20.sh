# needs BASE, AUTH, ACCT (a fresh account) and a 4-shard cluster c (19.1); JA: a fresh jepsen-* account
K=$BASE/kv/$ACCT/c/k
NOW=$(date +%s%3N)   # R-RET-1: an op id is <t>_<id>, t the client clock in ms when first sent
# 20.1 a KV write's whole trace under the client's span
T=$(openssl rand -hex 16); S=$(openssl rand -hex 8)
curl -s -D /tmp/h20 -w ' %{http_code}\n' -H "$AUTH" -H "traceparent: 00-$T-$S-01" -X PUT "$K/user:2?op=${NOW}_v20-t" --data-binary 'dee'
grep -i '^tape-trace-complete:' /tmp/h20 | tr -d '\r'
O=$(grep -i '^tape-otlp-url:' /tmp/h20 | cut -d' ' -f2 | tr -d '\r')
curl -s "$O" > /tmp/o20.json
jq -c '.resourceSpans[] | .resource.attributes[0].value.stringValue as $s | .scopeSpans[].spans[] | [$s, .name, .kind, (((.endTimeUnixNano|tonumber) - (.startTimeUnixNano|tonumber)) / 1e6 | round), ([.attributes[] | select(.key == "tape.timing" or .key == "tape.duration.source" or .key == "tape.sql.statements") | .key] | join(","))]' /tmp/o20.json
# one tree: every span's parent is in the trace, except one root, whose parent is the client's span
jq -r --arg c "$S" --arg t "$T" '[.resourceSpans[].scopeSpans[].spans[]] as $a | ($a | map(.spanId)) as $ids | [($a | map(select(.traceId != $t)) | length), ($a | map(select(.parentSpanId as $p | $ids | index($p) | not)) | map(.parentSpanId == $c) )] | tostring' /tmp/o20.json
# the parent chain: router <- call <- supervisor <- run
jq -r '[.resourceSpans[].scopeSpans[].spans[]] as $a | ($a | map({key: .spanId, value: .}) | from_entries) as $by | $a[] | select(.name | startswith("PUT /k/")) | [.name, $by[.parentSpanId].name, $by[$by[.parentSpanId].parentSpanId].name, $by[$by[$by[.parentSpanId].parentSpanId].parentSpanId].name] | join(" <- ")' /tmp/o20.json
# 20.2 the same request by trace id, and as text through the signed link
curl -s -H "$AUTH" "$BASE/kv/$ACCT/c/traces/$T?key=user:2" | jq '[.resourceSpans[].scopeSpans[].spans[]] | length'
curl -s "$(grep -i '^tape-trace-url:' /tmp/h20 | cut -d' ' -f2 | tr -d '\r')&format=text" | head -5
# 20.3 an op id makes an unconditional write idempotent; reused on another key it is refused
curl -s -w ' %{http_code}\n' -H "$AUTH" -X PUT "$K/user:2?op=${NOW}_v20-a" --data-binary 'eve'
curl -s -w ' %{http_code}\n' -H "$AUTH" -X PUT "$K/user:2?op=${NOW}_v20-a" --data-binary 'eve'
curl -s -w ' %{http_code}\n' -H "$AUTH" $K/user:2
curl -s -w ' %{http_code}\n' -H "$AUTH" -X PUT "$K/user:3?op=${NOW}_v20-a" --data-binary 'eve'
# 20.4 a storage failure at commit rolls back, says so, and the trace shows it (faults apply to jepsen-* only)
curl -s -o /dev/null -w '%{http_code} ' -H "$AUTH" -X POST $BASE/kv/$JA/c -d '{"shards":1}'
curl -s -o /dev/null -w '%{http_code}\n' -H "$AUTH" -X PUT $BASE/_faults/$JA -d '{"seed":1,"p":{"storage_error":1}}'
curl -s -D /tmp/h20s -w ' %{http_code}\n' -H "$AUTH" -X PUT "$BASE/kv/$JA/c/k/x?op=${NOW}_v20-s" --data-binary 'lost'
grep -iE '^(tape-applied|tape-trace-complete):' /tmp/h20s | tr -d '\r'
curl -s "$(grep -i '^tape-otlp-url:' /tmp/h20s | cut -d' ' -f2 | tr -d '\r')" | jq -c '[.resourceSpans[].scopeSpans[].spans[] | select(.name == "PUT /k/x") | {status: .status.code, rolled_back: ([.attributes[] | select(.key == "tape.run.rolled_back") | .value.boolValue][0])}]'
curl -s -o /dev/null -w '%{http_code} ' -H "$AUTH" -X PUT $BASE/_faults/$JA -d 'null'
curl -s -w ' %{http_code}\n' -H "$AUTH" $BASE/kv/$JA/c/k/x
