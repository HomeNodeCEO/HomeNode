import { readingFoundations } from './readingFoundations';
import { readingLeases } from './readingLeases';
import { readingCapitalization } from './readingCapitalization';
import { readingMarketModeling } from './readingMarketModeling';

export const readings = [...readingFoundations, ...readingLeases, ...readingCapitalization, ...readingMarketModeling];
