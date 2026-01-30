export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<number[]>;
  batchEmbed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}
