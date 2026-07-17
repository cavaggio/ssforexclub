# V3 null-trigger repair validation

This marker PR validates the production repair that prevents pairs without a confirmed market-movement trigger from throwing `Cannot read properties of null (reading 'triggerPrice')`.

Validation scope:

- authoritative source generation applies the null guard before tests and server startup;
- no-trigger market-movement analysis returns a structured payload;
- missing direction/candles fail closed without throwing;
- `evaluateV3()` returns a normal rejected result when no fresh trigger exists;
- existing Stage 1, Stage 2, independent V3, ICT isolation, and dashboard checks remain intact.
