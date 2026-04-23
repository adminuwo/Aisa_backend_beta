# AI ADS Agent: Pricing & Credits Guide (INR)

This guide outlines the credit costs for various AI features, ensuring a **50% profit margin** based on current API costs from Google Vertex AI and OpenAI, converted to Indian Rupees (INR).

## 1. Currency & Credit Valuation
*   **Exchange Rate**: 1 USD = ₹92.60 INR
*   **Credit Value**: **1 Credit = ₹0.10 (10 Paise)**
*   **₹1.00 = 10 Credits**

## 2. Model Cost Breakdown (50% Profitability)

| Service | API Cost (USD) | API Cost (INR) | Selling Price (2x INR) | Recommended Credits |
| :--- | :--- | :--- | :--- | :--- |
| **AISA Chat (GPT-4o-mini)** | ~$0.001 | ₹0.09 | ₹0.18 | **2 Credits** |
| **AISA Image (Imagen 3)** | $0.04 | ₹3.70 | ₹7.40 | **74 Credits** |
| **AI Ads Agent (Full Pipeline)** | ~$0.13 | ₹12.04 | ₹24.08 | **241 Credits** |
| **Gemini 2.5 Flash** | ~$0.01 | ₹0.93 | ₹1.86 | **19 Credits** |

> [!IMPORTANT]
> The **AI Ads Agent** pipeline uses **GPT-4** for high-end prompt engineering and **Imagen 3** for visual rendering. The 241-credit cost ensures we cover both API calls while maintaining a 50% margin.

## 3. Revenue Example
If a user generates **100 AI Ads**:
*   **Total Credits Consumed**: 21,800 Credits
*   **Revenue**: ₹2,180.00
*   **Estimated API Cost**: ₹1,092.00
*   **Net Profit**: **₹1,088.00**

## 4. Integration Details
*   **Model**: `gemini-1.5-flash` (Vertex AI)
*   **Image Engine**: `imagen-3.0-generate-001`
*   **Credit System**: Managed via `subscriptionService.js` and `creditSystem.js` middleware.
