set -u
# Run from service/: deletes each trace-checker anomaly rule in turn and runs the checker tests (docs/defects.md, R12).
out=${1:-verify/rca/mutate-checker.txt}; : > $out
rg -n "anomalies\.push\(|\bbad\('" jepsen/traces.ts jepsen/kv.ts | awk -F: '$1=="jepsen/traces.ts" || ($2>=225 && $2<=385) {print $1":"$2}' | while IFS=: read f l; do
  cp $f /tmp/orig.ts
  node -e "const fs=require('fs');const f='$f',l=$l;const a=fs.readFileSync(f,'utf8').split('\n');let s=a[l-1];const i=s.search(/anomalies\.push\(|\bbad\('/);s=s.slice(0,i)+s.slice(i).replace(/^anomalies\.push\(|^bad\(/,'void (');a[l-1]=s;fs.writeFileSync(f,a.join('\n'))"
  ty=$(sed -n "${l}p" /tmp/orig.ts | grep -o "type: '[a-z-]*'\|bad('[a-z-]*'" | head -1)
  if npx vitest run test/kv-jepsen.test.ts -t "the trace checker" >/tmp/m.log 2>&1; then r=SURVIVED; else r=killed; fi
  cp /tmp/orig.ts $f
  echo "$r $f:$l $ty" >> $out
done
git diff --quiet jepsen/ && echo CLEAN >> $out
