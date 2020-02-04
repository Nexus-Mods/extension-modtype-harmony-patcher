import { types } from 'vortex-api';

export interface IPatcherDetails {
  dataPath: string;
  entryPoint: string;
  modsPath: string;
  injectVIGO: boolean;
}

export interface IGameStoredInfo {
  game: types.IGameStored;
  discoveryPath: string;
}

export interface ISortedEntries {
  symlinks: string[];
  files: string[];
}
