// Chunk algorithm — implemented in step 3 (see .spec/reader.md).

export type Chunk = {
  i: number;
  text: string;
  anchor: number[];
};

export type ChunkMode = "page" | "selection";

export function chunkPage(_doc: Document): Chunk[] {
  return [];
}

export function chunkSelection(_sel: Selection): Chunk[] {
  return [];
}
