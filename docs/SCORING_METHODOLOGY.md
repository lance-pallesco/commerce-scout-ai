# Scoring methodology

Each candidate receives a deterministic 0–100 evidence score:

| Criterion | Maximum | Rule |
| --- | ---: | --- |
| Observed price fit | 25 | Full points only when an observed price is within the user range. |
| Evidence quality | 30 | Proportional to available name, description, category, price, and image fields. |
| Niche relevance | 20 | Full points only when observed product text matches the saved request niche; unrelated records receive zero and are filtered before persistence. |
| Information completeness | 25 | Proportional to the same five observed core fields. |

Missing fields lower evidence and completeness scores and appear as explicit concerns. Ties sort by stable product ID. Agent narrative findings can be attached only after validating their product IDs; they cannot alter score components.

The score is an evidence-coverage prioritization aid. It is not a prediction of demand, sales, conversion, profitability, safety, regulatory status, or product-market fit.
