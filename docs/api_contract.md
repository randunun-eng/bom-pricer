POST /price-bom

Request:
{
  "bom": "30A ESC x2\n40A ESC x1"
}

Response:
{
  "items": [
    {
      "description": "30A ESC",
      "qty": 2,
      "unit_price_usd": 1.07,
      "total_price_usd": 2.14,
      "supplier": "...",
      "confidence": 0.85,
      "reasoning": "..."
    }
  ],
  "currency": "USD",
  "generated_at": ISO8601
}
