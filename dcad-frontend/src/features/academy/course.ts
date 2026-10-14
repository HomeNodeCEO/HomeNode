import { foundations } from './foundations';
import { leaseModules } from './leases';
import { capitalizationModules } from './capitalization';
import { marketModelingModules } from './marketModeling';
export const modules = [...foundations, ...leaseModules, ...capitalizationModules, ...marketModelingModules];
export const questions = modules.flatMap(module => module.questions);
export const courseVersion = '2026-10-14';
