# Source-preserving planar topology checkpoint

`createNeighborhoodPostgisTopology(pool).build(input)` consumes the trusted cached-linework preparation envelope and creates source-backed planar faces. It is an internal inactive service: no route, schema, provider, worker, report consumer or production configuration is changed. The pool must already have bounded connection acquisition configured.

## Geometry policy

The initial supported projected CRS is EPSG26914 (NAD83 / UTM14N, metres), verified against the database spatial reference definition. The conservative input support window is longitude[-98.5,-95.5], latitude[31,34.5]; it is not a jurisdiction boundary or survey accuracy guarantee. Output includes authoritative projected EWKB, display GeoJSON4326 and observed PostGIS/GEOS/PROJ versions.

This version supports only zero snap. It transforms source vertices, nodes real line intersections and overlapping segments, and polygonizes actual closed faces. It never adds an envelope edge, endpoint connector, rectangle, circle, hull, buffer or geometry-repair fallback. A gap remains a gap. Nested faces retain holes; slivers under1m² are not silently discarded. Unsupported, invalid or over-budget results contain no usable partial graph.

Every edge retains all matching original source primitive occurrences, including feature, part, segment index and endpoint fractions measured on that primitive. This avoids ambiguity for closed or retraced source lines. The `postgis-planar-v2` policy requires exact normalized NDR EWKB equality between the edge and its `ST_LineSubstring` reconstruction from those source fractions. This is reproducible construction at stored floating-point precision, not a claim of mathematically exact containment: computed intersection coordinates can fail `ST_CoveredBy` on their original theoretical line. No distance tolerance or nearest-source attribution is used, and noded geometry is unchanged. Every positive-length original primitive also requires complete fractional interval coverage from 0 through 1, with no gaps or lost duplicate occurrences. Unprovable edges or source intervals fail closed. Planar crossings do not establish bridge/ramp travel connectivity or permission to cross a geographic barrier.

Multiple source occurrences on the same edge must additionally have positive-length exact interior overlap between their original projected primitives (`ST_Relate(...,'1********')`). This rejects non-collinear sources whose reconstructed substring bytes happen to coincide at floating-point precision. It preserves truly duplicated/overlapping support; incompatible multi-source attribution is incomplete, not silently assigned to a preferred source. These checks do not establish source accuracy or legal roadway identity.

## Bounded work before expensive noding

The service admits at most512 original adjacent-coordinate primitive segments before connecting. A separate projected-box overlap query performs at most130,816 unordered primitive comparisons and retains at most4,097 candidate pairs (4,096 plus overflow sentinel). It runs before `ST_Node` or polygonization.

For S primitives, C original coordinates and P completely enumerated overlapping-box pairs, the conservative split-piece/source-reference upper bound is S+4P and the coordinate bound is C+8P. All adjacent, same-part, retraced and duplicate occurrences participate. Admission requires these bounds to fit the configured graph ceilings; truncated pair counts never become a claimed upper bound. No geographic-degree boxes or prefix truncation substitute for projected evidence.

Defaults additionally cap1,024 cells,8,192 edges,16,384 source references,32MB successful output and128KB per result row. The successful-output cap includes the exact UTF-8 JSON framing, status/revision fields and all metadata, checked separately from bounded manifest hashing work. Statement/read/acquisition ceilings are5s/20s/3s, with bounded rollback and connection cleanup. Callers can only lower limits. These are containment settings, not measured production latency. Dense or long road captures can require a future reviewed tile/seam approach; this version returns incomplete instead of silently simplifying them.

Failure control messages have a separate16KB maximum so even a requested one-byte payload limit can report a reason. They omit geometry, source descriptors, aliases and potentially large limitations, retaining only bounded hashes, counts and diagnostics with `metadata_not_returned`. A topology revision hashes normalized evidence, performed policy, admission and engine versions; its digest is neither authorization nor an independent geometry certificate.

## Testing and remaining scope

Synthetic Cartesian metre fixtures are explicitly translated to[700000,3600000] in26914 before transforming to4326. Expected square/curved/nested areas come from independent arithmetic, not supplied polygon outputs. Cases cover source gaps, duplicate evidence, intersections, corner contacts, dangles, closed/retraced/bow-tie lines, slivers, dense-crossing admission, deterministic content and failure controls.

The native suite uses the unchanged guarded unique-child PostgreSQL/PostGIS CI helper; it does not access a shared/live database or drop schemas/databases. Native outcomes must be recorded from the exact CI commit. Mock geometry rows and fixture arithmetic alone do not prove native SQL or topology validity.

This result is not directly compatible with the selection engine or a report. A reviewed adapter still needs explicit cell eligibility/similarity, subject containment and geographic barrier policy. Zero-incident diagnostic edges must not masquerade as cell boundaries. Chosen cells still require actual dissolve/validity/perimeter verification and distinct competitive memberships. Immutable publication, source-reader orchestration, population statistics, research and atomic Custom/UAD application remain separate unactivated work.
