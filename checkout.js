// ==UserScript==
// @name         ALICATE - Checkout Optimizer
// @namespace    http://tampermonkey.net/
// @version      2025-11-05-rev23
// @description  Analyzes your AliExpress checkout page to suggest intelligent order splits that minimize import taxes.
// @author       @esauvisky
// @run-at       document-start
// @match        https://www.aliexpress.com/p/trade/confirm.html*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=aliexpress.com
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // --- Config ---
    const OPTIMIZATION_CONTAINER_ID = 'custom-optimization-suggestions-container';
    const SPLIT_DATA_KEY = 'aliExpressCartSplits';
    const OPTIMAL_SUBTOTAL_THRESHOLD = 49.00;
    let USER_DEFINED_OPTIMAL_TAX_RATE = 0.45;

    // New: control whether to suppress rendering when savings <= 0
    const ALWAYS_SHOW_SPLITS_IF_AVAILABLE = true;
    const SAVINGS_HIDE_THRESHOLD = 0.01; // only hide if loss > 1 cent (and ALWAYS_SHOW... is false)

    // --- Globals ---
    let checkoutApiData = null;


    // --- Unified Data Processor ---
    function processCheckoutData(apiResponse) {
        // Both XHR and fetch interceptors pass the parsed JSON with shape {data:{data:{...}}}
        const maybeData = apiResponse && apiResponse.data && apiResponse.data.data;
        if (maybeData && typeof maybeData === 'object') {
            checkoutApiData = maybeData;
            console.log('[AE Optimizer] Processed Checkout API Data:', checkoutApiData);
            setTimeout(runOptimization, 250);
        } else {
            console.warn('[AE Optimizer] Unexpected API structure:', apiResponse);
        }
    }

    // --- Interception ---

    // 1) XHR
    const originalXHRopen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (_method, _url) {
        this._url = _url;
        return originalXHRopen.apply(this, arguments);
    };
    const originalXHRsend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (_body) {
        if (this._url && (
            this._url.toLowerCase().includes('mtop.aliexpress.checkout.renderorder') ||
            this._url.toLowerCase().includes('mtop.aliexpress.checkout.adjustorder')
        )) {
            this.addEventListener('load', function () {
                try {
                    console.log(`%c[INTERCEPTED XHR] ${this._url}`, 'background:#007bff;color:#fff;padding:2px 5px;border-radius:3px;');
                    processCheckoutData(JSON.parse(this.responseText));
                } catch (e) { console.error('[AE Optimizer] XHR parse error:', e); }
            });
        }
        return originalXHRsend.apply(this, arguments);
    };

    // 2) fetch
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const [url] = args;
        const res = await originalFetch(...args);
        const urlString = (url instanceof Request) ? url.url : url;

        if (typeof urlString === 'string' && (
            urlString.toLowerCase().includes('mtop.aliexpress.checkout.renderorder') ||
            urlString.toLowerCase().includes('mtop.aliexpress.checkout.adjustorder')
        )) {
            console.log(`%c[INTERCEPTED FETCH] ${urlString}`, 'background:#28a745;color:#fff;padding:2px 5px;border-radius:3px;');
            try {
                const clone = res.clone();
                const data = await clone.json();
                processCheckoutData(data);
            } catch (e) { console.error('[AE Optimizer] fetch parse error:', e); }
        }
        return res;
    };

    // --- Helpers ---
    function parseCurrency(text) {
        if (typeof text !== 'string') return NaN;
        // Common AE strings: "Free", "Free shipping"
        if (/^\s*free(?:\s+shipping)?\s*$/i.test(text)) return 0;
        return parseFloat(text.replace(/[^\d.-]/g, '').replace(/,/g, ''));
    }

    function normalizeSku(sku) {
        if (!sku) return '';
        return sku.toLowerCase().replace(/[\s,/-]/g, '');
    }

    function generateCartFingerprint(cartItems) {
        if (!cartItems || !cartItems.length) return '';
        return cartItems.map(i => i.uniqueId).sort().join('|');
    }

    function findInsertBeforeNode() {
        // Original selector
        let anchor = document.querySelector('.pl-order-toal-container__btn-box');
        if (anchor && anchor.parentNode) return anchor;

        // Try near "Place order" / "Pay now" buttons
        const btns = Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter(b => /place order|pay now/i.test(b.textContent || ''));
        if (btns.length && btns[0].parentNode) return btns[0];

        // Try something around totals box
        const totalBox = document.querySelector('[class*="order_total"],[id*="order_total"],[data-spm*="place_order"]');
        if (totalBox) return totalBox;

        // Fallback: top of body
        return document.body.firstElementChild || document.body;
    }

    // --- Tax extraction ---
    function calculateTaxValues() {
        const summary = checkoutApiData?.checkout_order_summary_TOTAL_SUMMARY?.fields?.summaryLines;
        if (!Array.isArray(summary)) return null;

        let taxAmount = 0;
        for (const line of summary) {
            const title = line?.title?.title || '';
            const valStr = line?.content?.content;
            if (!valStr) continue;
            if (/^(duty)$/i.test(title) || /^(icms)$/i.test(title) || /\b(vat|iva|tax|duty|icms)\b/i.test(title)) {
                const part = parseCurrency(valStr);
                if (!isNaN(part)) taxAmount += part;
            }
        }

        const totalLine = checkoutApiData?.checkout_order_total_116150?.fields?.priceList?.[0]?.content?.content;
        const totalAmount = totalLine ? parseCurrency(totalLine) : NaN;
        if (isNaN(totalAmount)) return null;

        const base = totalAmount - taxAmount;
        const taxRate = (base > 0 && taxAmount > 0) ? (taxAmount / base) : 0;
        return { taxAmount, taxRate };
    }

    // --- Robust Item Parsing (Handles multiple API response structures) ---
    function parseCartItems() {
        const items = [];
        if (!checkoutApiData) return items;

        // --- STRATEGY 1: Detect individual products (newer API structure, as in the example) ---
        const productKeys = Object.keys(checkoutApiData).filter(k => {
            const block = checkoutApiData[k];
            // Check for the specific type and that it has price information.
            return block && block.type === 'pc_checkout_product' && block.fields?.prices?.children?.retailPrice;
        });

        if (productKeys.length > 0) {
            console.log('[AE Optimizer] Detected individual product structure. Using new parser.');
            for (const pKey of productKeys) {
                const p = checkoutApiData[pKey]?.fields;
                if (!p) continue;

                const unitPrice = p.prices?.children?.retailPrice?.value;
                const quantity = p.quantity?.current;
                if (isNaN(unitPrice) || isNaN(quantity) || quantity <= 0) continue;

                // Each product has a signature that links it to its shipping info.
                const signature = p.signature;
                if (!signature) {
                     console.warn(`[AE Optimizer] Product block ${pKey} is missing a signature. Cannot link shipping.`);
                     continue;
                }
                const shippingKey = `pc_checkout_shipping_option_${signature}`;
                const shippingBlock = checkoutApiData[shippingKey];

                let shippingCost = 0;
                if (shippingBlock) {
                    const sel = shippingBlock.fields?.selectedFreightService;
                    const freight = sel?.freightCost || sel?.shippingCostContent || 'Free';
                    const parsed = parseCurrency(String(freight));
                    shippingCost = isNaN(parsed) ? 0 : parsed;
                } else {
                    console.warn(`[AE Optimizer] No shipping block found for product with signature: ${signature}. Assuming free shipping for this item.`);
                }

                const displayName = p.title || 'Item';
                const skuText = p.sku?.skuInfo || '';
                const itemUrl = p.itemUrl || '';
                // The shipping cost is for the total quantity of this specific item.
                const shippingPerUnit = quantity > 0 ? (shippingCost / quantity) : 0;

                const base = {
                    unitPrice,
                    quantity,
                    displayName,
                    originalSkuText: skuText,
                    itemUrl,
                    proportionalShippingPerUnit: shippingPerUnit,
                    effectivePriceForTax: unitPrice + shippingPerUnit,
                    uniqueId: normalizeSku(skuText) ? `${displayName} (${normalizeSku(skuText)})` : displayName
                };

                for (let i = 0; i < quantity; i++) {
                    // Storing individual, non-cloned item data for splitting logic
                    items.push({
                        unitPrice: base.unitPrice,
                        displayName: base.displayName,
                        originalSkuText: base.originalSkuText,
                        itemUrl: base.itemUrl,
                        effectivePriceForTax: base.effectivePriceForTax,
                        uniqueId: `${base.uniqueId}_${i}` // Unique ID for split tracking
                    });
                }
            }
            return items;
        }

        // --- STRATEGY 2: Detect grouped products by seller (legacy parser, logic unchanged) ---
        const groupKeys = Object.keys(checkoutApiData).filter(k => {
            const block = checkoutApiData[k];
            return block && /pc_checkout_group_product_/i.test(k) && block.fields?.intentionOrderList;
        });

        if (groupKeys.length > 0) {
            console.log('[AE Optimizer] Detected grouped product structure. Using legacy parser.');
            const shippingGroups = {};
            Object.keys(checkoutApiData).forEach(k => {
                if (/pc_checkout_group_shipping_/i.test(k)) shippingGroups[k] = checkoutApiData[k];
            });

            for (const gk of groupKeys) {
                const group = checkoutApiData[gk];
                const intList = group.fields.intentionOrderList || [];

                const modeSuffix = gk.replace(/^pc_checkout_group_product_/, '');
                const shipKey = Object.keys(shippingGroups).find(sk => sk.endsWith(modeSuffix)) || null;

                let shippingCost = 0;
                if (shipKey) {
                    const sel = shippingGroups[shipKey]?.fields?.selectedFreightService;
                    const freight = sel?.freightCost || sel?.shippingCostContent || 'Free';
                    const parsed = parseCurrency(String(freight));
                    shippingCost = isNaN(parsed) ? 0 : parsed;
                }

                for (const p of intList) {
                    const unitPrice = p?.prices?.children?.retailPrice?.value;
                    const quantity = p?.quantity?.current;
                    if (isNaN(unitPrice) || isNaN(quantity) || quantity <= 0) continue;

                    const displayName = p?.title || 'Item';
                    const skuText = p?.sku?.skuInfo || '';
                    const itemUrl = p?.itemUrl || '';
                    const shippingPerUnit = quantity > 0 ? (shippingCost / quantity) : 0;

                    const base = {
                        unitPrice,
                        quantity,
                        displayName,
                        originalSkuText: skuText,
                        itemUrl,
                        proportionalShippingPerUnit: shippingPerUnit,
                        effectivePriceForTax: unitPrice + shippingPerUnit,
                        uniqueId: normalizeSku(skuText) ? `${displayName} (${normalizeSku(skuText)})` : displayName
                    };

                    for (let i = 0; i < quantity; i++) {
                        items.push({
                            unitPrice: base.unitPrice,
                            displayName: base.displayName,
                            originalSkuText: base.originalSkuText,
                            itemUrl: base.itemUrl,
                            effectivePriceForTax: base.effectivePriceForTax,
                            uniqueId: `${base.uniqueId}_${i}`
                        });
                    }
                }
            }
            return items;
        }

        // If neither strategy found items
        console.warn('[AE Optimizer] Could not find any known product structure in checkout data. Items will be empty.');
        return items;
    }

    // --- Split heuristic ---
    function suggestSplits(cartItems, threshold, optimalTaxRate, currentOrderTaxRate) {
        if (!cartItems || cartItems.length === 0) return { splits: [], totalEstimatedTax: 0, quantityWarnings: [] };
        const allItems = [...cartItems].sort((a, b) => b.effectivePriceForTax - a.effectivePriceForTax);
        const splits = [];
        let totalEstimatedTax = 0;
        const quantityWarnings = [];

        while (allItems.length > 0) {
            let currentSplit = { items: [], subtotal: 0, estimatedTax: 0 };
            for (let i = allItems.length - 1; i >= 0; i--) {
                const item = allItems[i];
                if (currentSplit.subtotal + item.effectivePriceForTax <= threshold) {
                    currentSplit.items.push(item);
                    currentSplit.subtotal += item.effectivePriceForTax;
                    allItems.splice(i, 1);
                }
            }
            if (currentSplit.items.length === 0 && allItems.length > 0) {
                const largestItem = allItems.shift();
                currentSplit.items.push(largestItem);
                currentSplit.subtotal = largestItem.effectivePriceForTax;
            }
            if (currentSplit.items.length > 0) {
                currentSplit.estimatedTax = currentSplit.subtotal *
                    (currentSplit.subtotal <= threshold ? optimalTaxRate : currentOrderTaxRate);
                totalEstimatedTax += currentSplit.estimatedTax;
                splits.push(currentSplit);
            }
        }

        // Analyze splits for quantity warnings
        const itemQuantityMap = new Map();

        // Count total quantities needed per unique item across all splits
        splits.forEach((split, splitIndex) => {
            split.items.forEach(item => {
                const baseKey = item.uniqueId.replace(/_\d+$/, ''); // Remove the _index suffix
                if (!itemQuantityMap.has(baseKey)) {
                    itemQuantityMap.set(baseKey, {
                        displayName: item.displayName,
                        originalSkuText: item.originalSkuText,
                        totalNeeded: 0,
                        splitDistribution: []
                    });
                }
                const itemData = itemQuantityMap.get(baseKey);
                itemData.totalNeeded++;

                // Track which split this item appears in
                let splitEntry = itemData.splitDistribution.find(s => s.splitIndex === splitIndex);
                if (!splitEntry) {
                    splitEntry = { splitIndex, count: 0 };
                    itemData.splitDistribution.push(splitEntry);
                }
                splitEntry.count++;
            });
        });

        // Check for items that appear in multiple splits (quantity splits needed)
        itemQuantityMap.forEach((itemData, baseKey) => {
            if (itemData.splitDistribution.length > 1) {
                quantityWarnings.push({
                    displayName: itemData.displayName,
                    originalSkuText: itemData.originalSkuText,
                    totalQuantity: itemData.totalNeeded,
                    splitDistribution: itemData.splitDistribution
                });
            }
        });

        return { splits, totalEstimatedTax, quantityWarnings };
    }

    // --- UI helpers ---

    function ensureContainer() {
        let container = document.getElementById(OPTIMIZATION_CONTAINER_ID);
        if (!container) {
            container = document.createElement('div');
            container.id = OPTIMIZATION_CONTAINER_ID;
            container.style.cssText = 'margin:15px 0;padding:20px;border:1px solid #ddd;background:#fdfdfd;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.05);';
            const anchor = findInsertBeforeNode();
            if (anchor?.parentNode) {
                anchor.parentNode.insertBefore(container, anchor);
            } else {
                document.body.appendChild(container);
            }
        }
        return container;
    }

    function addStyles() {
        const styleId = 'custom-split-applier-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
              #${OPTIMIZATION_CONTAINER_ID} .split-box{border:1px dashed #c0c0c0;padding:10px;margin-top:10px;border-radius:4px;background:#fff}
              #${OPTIMIZATION_CONTAINER_ID} .split-box h4{margin-top:0;margin-bottom:8px;color:#333;font-size:15px}
              #${OPTIMIZATION_CONTAINER_ID} .split-box p{margin:4px 0;font-size:13px}
              #${OPTIMIZATION_CONTAINER_ID} .split-item-list{list-style-type:disc;padding-left:20px;margin-top:8px;margin-bottom:0}
              #${OPTIMIZATION_CONTAINER_ID} .split-item-list li a{font-size:12px;line-height:1.4;color:#555;text-decoration:none}
              #${OPTIMIZATION_CONTAINER_ID} .split-item-list li a:hover{text-decoration:underline;color:#0056b3}
              #${OPTIMIZATION_CONTAINER_ID} .split-item-list li b{font-weight:bold;color:#000}

            `;
          document.head.appendChild(style);
      }
  }

    function addGoToCartListener() {
        const btn = document.getElementById('goToCartBtn');
        if (!btn) return;

        btn.addEventListener('click', () => {
            window.open('https://www.aliexpress.com/p/shoppingcart/index.html', '_blank');
        });
    }

    // ---------------------------------------

    function buildSummaryHtml(totalEstimatedTax, originalTax, currentOrderTaxRate) {
        const delta = +(originalTax - totalEstimatedTax).toFixed(2); // normalize rounding noise
        const savings = delta;
        const savingsColor = savings > 0.01 ? '#27ae60' : (savings < -0.01 ? '#c0392b' : '#555');
        const label = savings > 0.01 ? 'Savings' : (savings < -0.01 ? 'Loss' : 'Estimated savings');

        return `
      <h2 style="margin-top:0;margin-bottom:15px;font-size:18px;color:#333;border-bottom:1px solid #eee;padding-bottom:10px;">📈 Order Split Suggestions</h2>
      <ul style="list-style:none;padding:0;margin:0 0 20px 0;font-size:14px;line-height:2.0;">
        <li>Current Tax: <strong style="color:#c0392b;">US $${originalTax.toFixed(2)}</strong></li>
        <li>Current Tax Rate: <strong style="color:#c0392b;">${(currentOrderTaxRate * 100).toFixed(2)}%</strong></li>
        <li style="padding:8px 0;"><hr style="border:0;border-top:1px solid #eee;"></li>
        <li>Assumed Optimal Tax Rate: <strong>${(USER_DEFINED_OPTIMAL_TAX_RATE * 100).toFixed(0)}%</strong></li>
        <li>Est. Tax w/ Splits: <strong style="color:${savingsColor};">US $${totalEstimatedTax.toFixed(2)}</strong></li>
        <li style="font-weight:bold;">${label}: <strong style="color:${savingsColor};font-size:15px;">US $${Math.abs(savings).toFixed(2)}</strong></li>
      </ul>
    `;
  }

    function buildFullSuggestionHtml(splitsData, originalTax, currentOrderTaxRate) {
        const { splits } = splitsData;
        let html = buildSummaryHtml(splitsData.totalEstimatedTax, originalTax, currentOrderTaxRate);
        html += `
      <div style="margin-top:15px;margin-bottom:25px;text-align:center;">
        <button id="goToCartBtn" style="padding:10px 20px;background:#f0ad4e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;font-weight:bold;">🛒 Go to Cart to Apply Splits</button>
      </div>
      <h3>Suggested Orders:</h3>
    `;
      splits.forEach((split, idx) => {
          html += `<div class="split-box"><h4>Order ${idx + 1}</h4><p>Subtotal: <strong>US $${split.subtotal.toFixed(2)}</strong></p><p>Estimated Tax: US $${split.estimatedTax.toFixed(2)}</p><ul class="split-item-list">`;
          const counts = {};
          split.items.forEach(it => {
              // Use simplified key without the unique index we added for the splitting logic
              const k = `${it.displayName} (${it.originalSkuText})`;
              if (!counts[k]) counts[k] = { ...it, count: 0 };
              counts[k].count++;
          });
          for (const k in counts) {
              const it = counts[k];
              html += `<li><a href="${it.itemUrl}" target="_blank" title="${it.displayName}">${it.count} × ${it.displayName}${it.originalSkuText ? ` (<b>${it.originalSkuText}</b>)` : ''}</a></li>`;
          }
          html += `</ul></div>`;
      });
      return html;
  }

    /**
     * Displays a compact message when order splitting is not beneficial.
     */
    function displayNoSplitsPossibleUI(currentOrderTaxRate) {
        const container = ensureContainer();
        container.style.cssText = `margin-top: 15px; margin-bottom: 15px; padding: 15px; border: 1px solid #ddd; background-color: #f8f8f8; border-radius: 8px; text-align: center;`;
        const taxRatePercent = (currentOrderTaxRate * 100).toFixed(2);
        container.innerHTML = `<p style="margin: 0; font-size: 14px; color: #555;">⚠️ This order cannot be optimized by splitting.<br>Current Order Effective Tax Rate: <strong style="color: #c0392b; font-weight: bold;">${taxRatePercent}%</strong></p>`;
        localStorage.removeItem(SPLIT_DATA_KEY);
    }

    /**
     * Displays a warning that the user is checking out a sub-order.
     */
    function displaySubOrderWarningUI() {
        const container = ensureContainer();
        container.style.cssText = `margin: 15px 0; padding: 15px; border: 1px solid #aed6f1; background-color: #eaf2f8; border-radius: 8px; text-align: center;`;
        container.innerHTML = `
            <p style="margin: 0 0 10px 0; font-size: 14px; color: #154360;">
                📝 It looks like you're checking out a partial order based on a previous plan.
            </p>
            <button id="resetAndRecalculateBtn" style="background-color: #3498db; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                Recalculate for This Order
            </button>`;

        document.getElementById('resetAndRecalculateBtn')?.addEventListener('click', () => {
            console.log("Resetting master plan and recalculating for the current sub-order.");
            localStorage.removeItem(SPLIT_DATA_KEY);
            runOptimization();
        });
    }

    function displayOptimizationSuggestions(splitsData, originalTax, currentOrderTaxRate, cartFingerprint) {
        addStyles();
        const container = ensureContainer();

        const totalEstimatedTax = +splitsData.totalEstimatedTax.toFixed(2);
        const delta = +(originalTax - totalEstimatedTax).toFixed(2);
        const isLossBeyondThreshold = delta < -SAVINGS_HIDE_THRESHOLD;

        // Store payload: Includes the detailed item list required for the hover popup
        const payload = {
            splits: splitsData.splits.map(s => ({
                subtotal: s.subtotal,
                estimatedTax: s.estimatedTax,
                // Only store necessary fields for the popup to keep payload small
                items: s.items.map(i => ({
                    displayName: i.displayName,
                    originalSkuText: i.originalSkuText,
                    itemUrl: i.itemUrl
                }))
            })),
            originalTax,
            originalCartFingerprint: cartFingerprint,
            totalEstimatedTax: splitsData.totalEstimatedTax,
            quantityWarnings: splitsData.quantityWarnings || []
        };
        localStorage.setItem(SPLIT_DATA_KEY, JSON.stringify(payload));

        // New behavior: if we have more than one split, always show the plan.
        if (ALWAYS_SHOW_SPLITS_IF_AVAILABLE && splitsData.splits.length > 1) {
            container.innerHTML = buildFullSuggestionHtml(splitsData, originalTax, currentOrderTaxRate);
            addGoToCartListener();
            return;
        }

        // Old behavior (kept as fallback if you flip the flag off)
        if (delta <= SAVINGS_HIDE_THRESHOLD && !isLossBeyondThreshold) {
            container.innerHTML = buildSummaryHtml(totalEstimatedTax, originalTax, currentOrderTaxRate) +
                `<p style="color:#555;text-align:center;margin-top:12px;">Splitting likely won’t change taxes much for this cart.</p>`;
        } else if (isLossBeyondThreshold) {
            container.innerHTML = buildSummaryHtml(totalEstimatedTax, originalTax, currentOrderTaxRate) +
                `<p style="color:#c0392b;text-align:center;margin-top:12px;font-weight:bold;">Splitting appears worse by US $${Math.abs(delta).toFixed(2)}.</p>`;
        } else {
            container.innerHTML = buildFullSuggestionHtml(splitsData, originalTax, currentOrderTaxRate);
            addGoToCartListener();
        }
    }

    // --- Orchestrator ---
    function runOptimization() {
        const anchor = findInsertBeforeNode();
        if (!checkoutApiData || !anchor) {
            console.warn("[AE Optimizer] Did not find checkoutApiData or a UI anchor point. Aborting.");
            return;
        }
        const currentCartItems = parseCartItems();
        if (currentCartItems.length === 0) {
            console.error("[AE Optimizer] Did not find any items in cart after parsing. Aborting.");
            return;
        }

        const fingerprint = generateCartFingerprint(currentCartItems);
        const savedDataJSON = localStorage.getItem(SPLIT_DATA_KEY);
        if (savedDataJSON) {
            try {
                const saved = JSON.parse(savedDataJSON);
                if (saved?.originalCartFingerprint && saved.originalCartFingerprint !== fingerprint) {
                    displaySubOrderWarningUI();
                    return;
                }
            } catch {}
        }

        const summary = calculateTaxValues();
        if (!summary) {
             console.error("[AE Optimizer] Could not calculate tax values. Aborting.");
             return;
        }
        const { taxAmount, taxRate } = summary;
        if (isNaN(taxAmount)) return;

        const splitsData = suggestSplits([...currentCartItems], OPTIMAL_SUBTOTAL_THRESHOLD, USER_DEFINED_OPTIMAL_TAX_RATE, taxRate);

        if (splitsData.splits.length <= 1) {
            displayNoSplitsPossibleUI(taxRate);
        } else {
            displayOptimizationSuggestions(splitsData, taxAmount, taxRate, fingerprint);
        }
    }

})();
