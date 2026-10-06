import type { MarketConditionsResponse } from './api';
import type { CustomCohortPreviewGroup } from '../features/neighborhood/customCohortPreviewController';
import type { ExplorationLandUse } from './explorationLandUse';

export interface NeighborhoodFormReview {
  explorationIdentity: string | null;
  builtUp: string;
  growth: string;
  demandSupply: string;
  boundaries: string;
  priceLow: string;
  priceHigh: string;
  pricePredominant: string;
  ageLow: string;
  ageHigh: string;
  agePredominant: string;
}
export const EMPTY_NEIGHBORHOOD_FORM: NeighborhoodFormReview = { explorationIdentity: null,
  builtUp: '', growth: '', demandSupply: '', boundaries: '', priceLow: '', priceHigh: '', pricePredominant: '', ageLow: '', ageHigh: '', agePredominant: '' };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: number | null) => value === null ? '' : String(Math.round(value));

export function neighborhoodStudyFigures(response: MarketConditionsResponse, group: CustomCohortPreviewGroup,
  explorationIdentity: string, landUse: ExplorationLandUse | null, previous: NeighborhoodFormReview): NeighborhoodFormReview {
  const analysis = response.analyses.find(item => item.market.key === 'exploration');
  const stock = object(object(object(object(group.summary).selected).stock).metrics), year = object(stock.year_built);
  const endYear = analysis?.period.end ? Number(analysis.period.end.slice(0, 4)) : null;
  const age = (value: unknown) => { const built = numeric(value); return endYear !== null && built !== null && built <= endYear ? endYear - built : null; };
  return { ...previous, explorationIdentity,
    builtUp: landUse?.explorationIdentity === explorationIdentity ? landUse.built_up_band : previous.builtUp,
    boundaries: previous.boundaries || 'Selected subdivision parcels and their edge-sharing neighbors, as shown on the HomeNode exploration map.',
    // The legacy forms display PRICE in $000; CAD assessed values are not sold
    // prices. Use the exact selected-map closed-sale study, never CAD taxes.
    priceLow: text(numeric(analysis?.summary.minimum_sale_price) === null ? null : analysis!.summary.minimum_sale_price! / 1000),
    priceHigh: text(numeric(analysis?.summary.maximum_sale_price) === null ? null : analysis!.summary.maximum_sale_price! / 1000),
    pricePredominant: text(numeric(analysis?.summary.median_sale_price) === null ? null : analysis!.summary.median_sale_price! / 1000),
    ageLow: text(age(year.high)), ageHigh: text(age(year.low)), agePredominant: text(age(year.median)),
  };
}
