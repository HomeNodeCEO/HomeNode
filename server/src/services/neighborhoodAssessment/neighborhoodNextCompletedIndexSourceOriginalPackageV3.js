import { NEIGHBORHOOD_FIRST_COMPLETED_INDEX_SOURCE_ORIGINAL_PACKAGE_V3_SQL as FIRST_PACKAGE } from './neighborhoodSelectedTransactionOriginalPackageV2.js';
import { COMPLETED_INDEX_FIRST_SOURCE_CONTEXT_V3_SQL as FIRST } from './completedIndexFirstSourceV3Sql.js';
import { COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL as NEXT } from './completedIndexNextSourceV3Sql.js';

// Preserve the complete existing original/ENTIRE-cache/required-subject SQL.
// Only its diagnostic and fixed native NEXT selector differ. No caller SQL.
function nextPackage(){
  let sql=FIRST_PACKAGE;
  for(const [from,to]of [[FIRST,NEXT],['neighborhood-first-completed-index-source-original-package-v3',
    'neighborhood-next-completed-index-source-original-package-v3']]){
    if(sql.split(from).length!==2)throw new TypeError('neighborhood_next_completed_source_original_sql_shape');
    sql=sql.replace(from,to);
  }
  return sql;
}
export const NEIGHBORHOOD_NEXT_COMPLETED_INDEX_SOURCE_ORIGINAL_PACKAGE_V3_SQL=nextPackage();
