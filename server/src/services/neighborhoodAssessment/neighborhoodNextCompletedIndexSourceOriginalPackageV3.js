import { NEIGHBORHOOD_FIRST_COMPLETED_INDEX_SOURCE_ORIGINAL_PACKAGE_V3_SQL as FIRST_PACKAGE,
  NEIGHBORHOOD_OWNED_FIRST_SOURCE_ORIGINAL_PACKAGE_V3_SQL as OWNED_PACKAGE } from './neighborhoodSelectedTransactionOriginalPackageV2.js';
import { COMPLETED_INDEX_FIRST_SOURCE_CONTEXT_V3_SQL as FIRST,
  OWNED_FIRST_SOURCE_CONTEXT_V3_SQL as OWNED_FIRST } from './completedIndexFirstSourceV3Sql.js';
import { COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL as NEXT,
  OWNED_NEXT_SOURCE_CONTEXT_V3_SQL as OWNED_NEXT } from './completedIndexNextSourceV3Sql.js';

// Preserve the complete existing original/ENTIRE-cache/required-subject SQL.
// Only its diagnostic and fixed native NEXT selector differ. No caller SQL.
function nextPackage(owned=false){
  let sql=owned?OWNED_PACKAGE:FIRST_PACKAGE;
  for(const [from,to]of [[owned?OWNED_FIRST:FIRST,owned?OWNED_NEXT:NEXT],
    [owned?'neighborhood-owned-first-source-original-package-v3':'neighborhood-first-completed-index-source-original-package-v3',
    owned?'neighborhood-owned-next-source-original-package-v3':'neighborhood-next-completed-index-source-original-package-v3']]){
    if(sql.split(from).length!==2)throw new TypeError('neighborhood_next_completed_source_original_sql_shape');
    sql=sql.replace(from,to);
  }
  return sql;
}
export const NEIGHBORHOOD_NEXT_COMPLETED_INDEX_SOURCE_ORIGINAL_PACKAGE_V3_SQL=nextPackage();
export const NEIGHBORHOOD_OWNED_NEXT_SOURCE_ORIGINAL_PACKAGE_V3_SQL=nextPackage(true);
