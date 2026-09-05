export { ToolManagerService } from './tool-manager.service.js';
export type { ToolManagerServiceDependencies } from './tool-manager.service.js';
export { ToolContextProviderAdapter, createToolContextProvider } from './tool-context-provider.js';
export type {
  ToolContextProviderAdapterOptions,
  ToolContextLoadInput,
} from './tool-context-provider.js';

import { ToolManagerService } from './tool-manager.service.js';
import type { ToolManagerServiceDependencies } from './tool-manager.service.js';

export function createToolManagerService(
  dependencies: ToolManagerServiceDependencies,
): ToolManagerService {
  return new ToolManagerService(dependencies);
}
