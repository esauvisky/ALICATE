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

    // --- Configurações ---
    const OPTIMIZATION_CONTAINER_ID = 'custom-optimization-suggestions-container';
    const SPLIT_DATA_KEY = 'aliExpressCartSplits';
    const MINIMUM_SAVINGS_THRESHOLD = 0.05; // Não sugerir divisões para economias menores que 5 centavos.

    // --- Regras do Remessa Conforme (PRC) ---
    const PRC_LOWER_BRACKET_THRESHOLD = 50.00;
    const PRC_II_RATE_LOW = 0.20;
    const PRC_II_RATE_HIGH = 0.60;
    const PRC_II_DISCOUNT_USD = 20.00;
    const ICMS_RATE = 0.17;

    // --- Globais ---
    let checkoutApiData = null;

    // --- Processador de Dados Unificado ---
    function processCheckoutData(apiResponse) {
        const maybeData = apiResponse?.data?.data;
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

    // --- Motor de Cálculo de Impostos (Remessa Conforme) ---
    function calculatePrcTax(subtotal) {
        if (subtotal <= 0) return { totalTax: 0, importTax: 0, icmsTax: 0 };
        let importTax = (subtotal <= PRC_LOWER_BRACKET_THRESHOLD)
            ? subtotal * PRC_II_RATE_LOW
            : Math.max(0, (subtotal * PRC_II_RATE_HIGH) - PRC_II_DISCOUNT_USD);
        const baseForIcms = subtotal + importTax;
        const icmsTax = (baseForIcms / (1 - ICMS_RATE)) - baseForIcms;
        return { totalTax: importTax + icmsTax, importTax, icmsTax };
    }

    // --- Funções Auxiliares ---
    function parseCurrency(text) {
        if (typeof text !== 'string') return NaN;
        if (/^\s*free(?:\s+shipping)?\s*$/i.test(text) || /^\s*grátis\s*$/i.test(text)) return 0;
        return parseFloat(text.replace(/[^\d,.-]/g, '').replace(',', '.'));
    }
    function normalizeSku(sku) { return sku ? sku.toLowerCase().replace(/[\s,/-]/g, '') : ''; }
    function generateCartFingerprint(groupedBySeller) {
        const sellerNames = Array.from(groupedBySeller.keys()).sort();
        const parts = sellerNames.map(name => {
            const items = groupedBySeller.get(name);
            const itemStrings = items.map(i => `${i.uniqueId}x${i.quantity}`).sort();
            return `${name}:${itemStrings.join(',')}`;
        });
        return parts.join('|');
    }
    function findInsertBeforeNode() {
        let anchor = document.querySelector('.pl-order-toal-container__btn-box');
        if (anchor?.parentNode) return anchor;
        const btns = Array.from(document.querySelectorAll('button,[role="button"]')).filter(b => /place order|pay now/i.test(b.textContent || ''));
        if (btns.length && btns[0].parentNode) return btns[0];
        const totalBox = document.querySelector('[class*="order_total"],[id*="order_total"],[data-spm*="place_order"]');
        return totalBox || document.body.firstElementChild || document.body;
    }

    // --- Extração de Impostos da UI ---
    function calculateTaxValues() {
        const summary = checkoutApiData?.checkout_order_summary_TOTAL_SUMMARY?.fields?.summaryLines;
        if (!Array.isArray(summary)) return null;
        let taxAmount = 0;
        for (const line of summary) {
            const title = line?.title?.title || '';
            const valStr = line?.content?.content;
            if (valStr && (/^(duty|icms|imposto)$/i.test(title) || /\b(vat|iva|tax|duty|icms)\b/i.test(title))) {
                const part = parseCurrency(valStr);
                if (!isNaN(part)) taxAmount += part;
            }
        }
        return { taxAmount };
    }

    // --- Parsing de Itens (Consciente dos Vendedores) ---
    function parseCartItems() {
        const groupedBySeller = new Map();
        if (!checkoutApiData) return groupedBySeller;

        const signatureToSeller = new Map();
        Object.values(checkoutApiData)
            .filter(block => block?.type === 'checkout_shop_title' && block.fields?.signatures)
            .forEach(block => {
                const sellerName = block.fields.title || 'Vendedor Desconhecido';
                block.fields.signatures.forEach(sig => signatureToSeller.set(sig, sellerName));
            });

        const processItem = (p, sellerName, shippingCost = 0) => {
            const unitPrice = p?.prices?.children?.retailPrice?.value;
            const quantity = p?.quantity?.current;
            if (isNaN(unitPrice) || isNaN(quantity) || quantity <= 0) return;

            const shippingPerUnit = quantity > 0 ? (shippingCost / quantity) : 0;
            const effectiveUnitPrice = unitPrice + shippingPerUnit;
            const displayName = p?.title || 'Item';
            const skuText = p?.sku?.skuInfo || '';
            const uniqueId = normalizeSku(skuText) ? `${displayName} (${normalizeSku(skuText)})` : displayName;

            if (!groupedBySeller.has(sellerName)) groupedBySeller.set(sellerName, new Map());
            const sellerItems = groupedBySeller.get(sellerName);

            if (!sellerItems.has(uniqueId)) {
                sellerItems.set(uniqueId, {
                    displayName, originalSkuText: skuText, itemUrl: p?.itemUrl || '',
                    unitPrice: effectiveUnitPrice, quantity: 0, uniqueId
                });
            }
            sellerItems.get(uniqueId).quantity += quantity;
        };

        Object.values(checkoutApiData)
            .filter(block => block?.type === 'pc_checkout_product' || (block?.type === 'pc_checkout_group_product' && block.fields?.intentionOrderList))
            .forEach(block => {
                if (block.type === 'pc_checkout_product') {
                    const p = block.fields;
                    const sellerName = signatureToSeller.get(p.signature) || 'Itens não atribuídos';
                    const shippingBlock = checkoutApiData[`pc_checkout_shipping_option_${p.signature}`];
                    let shippingCost = shippingBlock ? parseCurrency(String(shippingBlock.fields?.selectedFreightService?.freightCost || 'Free')) : 0;
                    processItem(p, sellerName, isNaN(shippingCost) ? 0 : shippingCost);
                } else { // Produtos agrupados
                    const groupIdentifier = block.id.replace(/^pc_checkout_group_product_/, '');
                    const shipKey = Object.keys(checkoutApiData).find(k => k.endsWith(groupIdentifier));
                    let shippingCost = shipKey ? parseCurrency(String(checkoutApiData[shipKey]?.fields?.selectedFreightService?.freightCost || 'Free')) : 0;
                    block.fields.intentionOrderList.forEach(p => {
                        const sellerName = signatureToSeller.get(p.signature) || 'Itens não atribuídos';
                        processItem(p, sellerName, isNaN(shippingCost) ? 0 : shippingCost);
                    });
                }
            });

        for (const [sellerName, itemsMap] of groupedBySeller.entries()) {
            groupedBySeller.set(sellerName, Array.from(itemsMap.values()));
        }
        return groupedBySeller;
    }


    // --- Motor Heurístico de Divisão (por Vendedor) ---
    function suggestSplits(groupedBySeller) {
        const finalSplits = [];
        let totalEstimatedTax = 0;

        for (const [sellerName, items] of groupedBySeller.entries()) {
            const itemsToPack = JSON.parse(JSON.stringify(items)).sort((a, b) => a.unitPrice - b.unitPrice);
            const totalUnits = itemsToPack.reduce((sum, item) => sum + item.quantity, 0);
            let unitsPacked = 0;

            while (unitsPacked < totalUnits) {
                let currentSplit = { items: [], subtotal: 0, sellerName };
                for (const item of itemsToPack) {
                    if (item.quantity > 0 && item.unitPrice > 0) {
                        const canFit = Math.floor((PRC_LOWER_BRACKET_THRESHOLD - currentSplit.subtotal) / item.unitPrice);
                        const qtyToAdd = Math.min(item.quantity, canFit);
                        if (qtyToAdd > 0) {
                            currentSplit.items.push({ ...item, quantity: qtyToAdd });
                            currentSplit.subtotal += qtyToAdd * item.unitPrice;
                            item.quantity -= qtyToAdd;
                            unitsPacked += qtyToAdd;
                        }
                    }
                }

                if (currentSplit.items.length === 0) {
                    // This block handles cases where the greedy packer gets stuck, which happens
                    // if the cheapest remaining item costs more than $50. The strategy is to
                    // create a new split with just ONE unit of that "oversized" item.
                    const firstUnpacked = itemsToPack.find(i => i.quantity > 0);
                    if (firstUnpacked) {
                         const qtyToAdd = 1; // FIX: Take only one unit of the oversized item.
                         currentSplit.items.push({ ...firstUnpacked, quantity: qtyToAdd });
                         currentSplit.subtotal += qtyToAdd * firstUnpacked.unitPrice;
                         firstUnpacked.quantity -= qtyToAdd; // FIX: Decrement quantity instead of setting to 0.
                         unitsPacked += qtyToAdd;
                    } else {
                        break; // No more items left to pack.
                    }
                }

                const taxDetails = calculatePrcTax(currentSplit.subtotal);
                currentSplit.taxDetails = taxDetails;
                currentSplit.estimatedTax = taxDetails.totalTax;
                totalEstimatedTax += taxDetails.totalTax;
                finalSplits.push(currentSplit);
            }
        }

        return { splits: finalSplits, totalEstimatedTax, strategy: "Empacotamento por Vendedor" };
    }


    // --- Funções da Interface do Usuário ---
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
