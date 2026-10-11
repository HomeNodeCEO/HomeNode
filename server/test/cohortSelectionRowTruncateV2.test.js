import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

test('selected-row TRUNCATE probes include every transitive additive native FK child before asserting immutability',()=>{
  const directory=new URL('../migrations/',import.meta.url),children=new Map();
  for(const name of readdirSync(directory).filter(n=>/^\d+_custom_cohort_selected_.*\.sql$/.test(n))){
    const sql=readFileSync(new URL(name,directory),'utf8');
    for(const match of sql.matchAll(/CREATE TABLE app\.(neighborhood_custom_cohort_selected_[a-z0-9_]+)\s*\(([\s\S]*?)\n\);/g)){
      for(const ref of match[2].matchAll(/REFERENCES app\.(neighborhood_custom_cohort_selected_[a-z0-9_]+)/g)){
        if(!children.has(ref[1]))children.set(ref[1],new Set());
        children.get(ref[1]).add(match[1]);
      }
    }
  }
  const prefix='neighborhood_custom_cohort_selected_';
  assert.ok(children.get(prefix+'union_v2_rows')?.has(prefix+'metrics_v2_rows'));
  assert.ok(children.get(prefix+'metrics_v2_rows')?.has(prefix+'statistics_v2_rows'));
  const fixture=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8'),
    probes=[...fixture.matchAll(/'TRUNCATE app\.neighborhood_custom_cohort_selected_[^'\r\n]*_v2_rows[^'\r\n]*'/g)].map(m=>m[0]);
  assert.ok(probes.length>=3,'must cover union, metric and contribution row probes');
  for(const probe of probes){
    const targets=new Set([...probe.matchAll(/app\.(neighborhood_custom_cohort_selected_[a-z0-9_]+)/g)].map(m=>m[1])),
      queue=[...targets],seen=new Set();
    while(queue.length){
      const parent=queue.pop();if(seen.has(parent))continue;seen.add(parent);
      for(const child of children.get(parent)??[]){
        assert.ok(targets.has(child),parent+' probe omits FK child '+child+' before its specific immutability assertion');
        queue.push(child);
      }
    }
    assert.doesNotMatch(probe,/CASCADE|DISABLE|DROP/);
  }
  assert.ok(fixture.includes('/immutable|mutation|not permitted/'),'do not replace actual guard assertions with generic FK acceptance');
});
