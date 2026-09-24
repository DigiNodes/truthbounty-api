describe(
  'aggregation confidence floor',
  () => {
    it(
      'clamps confidence below 0.5',
      () => {
        expect(
          applyConfidenceFloor(
            0.2,
          ),
        ).toBe(0.5);
      },
    );
  },
);

it(
  'preserves confidence above floor',
  () => {
    expect(
      applyConfidenceFloor(
        0.91,
      ),
    ).toBe(0.91);
  },
);

it(
  'handles NaN safely',
  () => {
    expect(
      applyConfidenceFloor(
        NaN,
      ),
    ).toBe(0.5);
  },
);

it(
  'clamps negative values',
  () => {
    expect(
      applyConfidenceFloor(
        -5,
      ),
    ).toBe(0.5);
  },
);

it(
  'handles infinite values safely',
  () => {
    expect(
      normalizeConfidence(
        Infinity,
      ),
    ).toBe(1);
  },
);

