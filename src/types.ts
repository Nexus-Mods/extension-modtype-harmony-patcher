import { types } from 'vortex-api';

export interface IDeployment {
  [modType: string]: types.IDeployedFile[];
}

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

export const FAKE_FILE: string = '__harmony_merge_fake_file';
