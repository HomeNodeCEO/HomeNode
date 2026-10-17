import { NEIGHBORHOOD_FOURTH_FIRST_SOURCE_ORIGINAL_PACKAGE_V3_SQL as FOURTH_PACKAGE } from './neighborhoodSelectedTransactionOriginalPackageV2.js';
import { FOURTH_FIRST_SOURCE_CONTEXT_V3_SQL as FOURTH_FIRST } from './completedIndexFirstSourceV3Sql.js';
import { FOURTH_NEXT_SOURCE_CONTEXT_V3_SQL as FOURTH_NEXT } from './completedIndexNextSourceV3Sql.js';
import { NEIGHBORHOOD_THIRD_FIRST_SOURCE_ORIGINAL_PACKAGE_V3_SQL as THIRD_PACKAGE } from './neighborhoodSelectedTransactionOriginalPackageV2.js';
import { THIRD_FIRST_SOURCE_CONTEXT_V3_SQL as THIRD_FIRST } from './completedIndexFirstSourceV3Sql.js';
import { THIRD_NEXT_SOURCE_CONTEXT_V3_SQL as THIRD_NEXT } from './completedIndexNextSourceV3Sql.js';
import { NEIGHBORHOOD_SECOND_FIRST_SOURCE_ORIGINAL_PACKAGE_V3_SQL as SECOND_PACKAGE } from './neighborhoodSelectedTransactionOriginalPackageV2.js';
import { SECOND_FIRST_SOURCE_CONTEXT_V3_SQL as SECOND_FIRST } from './completedIndexFirstSourceV3Sql.js';
import { SECOND_NEXT_SOURCE_CONTEXT_V3_SQL as SECOND_NEXT } from './completedIndexNextSourceV3Sql.js';
import { NEIGHBORHOOD_FIRST_COMPLETED_INDEX_SOURCE_ORIGINAL_PACKAGE_V3_SQL as FIRST_PACKAGE,
  NEIGHBORHOOD_OWNED_FIRST_SOURCE_ORIGINAL_PACKAGE_V3_SQL as OWNED_PACKAGE,
  NEIGHBORHOOD_RECOVERED_FIRST_SOURCE_ORIGINAL_PACKAGE_V3_SQL as RECOVERED_PACKAGE } from './neighborhoodSelectedTransactionOriginalPackageV2.js';
import { COMPLETED_INDEX_FIRST_SOURCE_CONTEXT_V3_SQL as FIRST,
  OWNED_FIRST_SOURCE_CONTEXT_V3_SQL as OWNED_FIRST, RECOVERED_FIRST_SOURCE_CONTEXT_V3_SQL as RECOVERED_FIRST } from './completedIndexFirstSourceV3Sql.js';
import { COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL as NEXT,
  OWNED_NEXT_SOURCE_CONTEXT_V3_SQL as OWNED_NEXT, RECOVERED_NEXT_SOURCE_CONTEXT_V3_SQL as RECOVERED_NEXT } from './completedIndexNextSourceV3Sql.js';

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

// Preserve the ENTIRE recovered original package and all caps; only select the
// independent recovered native NEXT and change its diagnostic. Read only.
function recoveredNextPackage(){
  let sql=RECOVERED_PACKAGE;
  for(const[from,to]of [[RECOVERED_FIRST,RECOVERED_NEXT],
    ['neighborhood-recovered-first-source-original-package-v3','neighborhood-recovered-next-source-original-package-v3']]){
    if(sql.split(from).length!==2)throw new TypeError('neighborhood_recovered_next_source_original_sql_shape');
    sql=sql.replace(from,to);
  }
  return sql;
}
export const NEIGHBORHOOD_RECOVERED_NEXT_SOURCE_ORIGINAL_PACKAGE_V3_SQL=recoveredNextPackage();

// ENTIRE existing WHOLE-original/ENTIRE-cache package; fixed second2 NEXT only.
function secondNextPackage(){
 let sql=SECOND_PACKAGE;
 for(const [from,to]of [[SECOND_FIRST,SECOND_NEXT],
  ['neighborhood-second-first-source-original-package-v3','neighborhood-second-next-source-original-package-v3']]){
  if(sql.split(from).length!==2)throw new TypeError('neighborhood_second_next_source_original_sql_shape');
  sql=sql.replace(from,to);
 }
 return sql;
}
export const NEIGHBORHOOD_SECOND_NEXT_SOURCE_ORIGINAL_PACKAGE_V3_SQL=secondNextPackage();

// ENTIRE third FIRST whole-original package; only fixed native NEXT differs.
function thirdNextPackage(){
 let sql=THIRD_PACKAGE;
 for(const[from,to]of [[THIRD_FIRST,THIRD_NEXT],
  ['neighborhood-third-first-source-original-package-v3','neighborhood-third-next-source-original-package-v3']]){
  if(sql.split(from).length!==2)throw new TypeError('neighborhood_third_next_source_original_sql_shape');
  sql=sql.replace(from,to);
 }
 return sql;
}
export const NEIGHBORHOOD_THIRD_NEXT_SOURCE_ORIGINAL_PACKAGE_V3_SQL=thirdNextPackage();

// ENTIRE actual fourth FIRST whole-original package; fixed native NEXT only.
function fourthNextPackage(){
 let sql=FOURTH_PACKAGE;
 for(const[from,to]of [[FOURTH_FIRST,FOURTH_NEXT],
  ['neighborhood-fourth-first-source-original-package-v3','neighborhood-fourth-next-source-original-package-v3']]){
  if(sql.split(from).length!==2)throw new TypeError('neighborhood_fourth_next_source_original_sql_shape');
  sql=sql.replace(from,to);
 }
 return sql;
}
export const NEIGHBORHOOD_FOURTH_NEXT_SOURCE_ORIGINAL_PACKAGE_V3_SQL=fourthNextPackage();
