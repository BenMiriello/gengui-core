declare module 'ml-pca' {
  export class PCA {
    constructor(
      dataset: number[][],
      options?: { center?: boolean; scale?: boolean },
    );
    predict(
      dataset: number[][],
      options?: { nComponents?: number },
    ): {
      to2DArray(): number[][];
    };
  }
}
