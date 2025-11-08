// ==UserScript==
// @name         ALICATE - Otimizador de Checkout
// @namespace    http://tampermonkey.net/
// @version      2025-11-05-rev35-pt-BR
// @description  Analisa sua página de checkout do AliExpress para sugerir divisões de pedido inteligentes que minimizam impostos, usando as regras do Remessa Conforme.
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
            console.warn('[AE Optimizer] Estrutura da API inesperada:', apiResponse);
        }
    }

    // --- Interceptação ---
    const originalXHRopen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (_method, _url) { this._url = _url; return originalXHRopen.apply(this, arguments); };
    const originalXHRsend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (_body) {
        if (this._url && (this._url.toLowerCase().includes('mtop.aliexpress.checkout.renderorder') || this._url.toLowerCase().includes('mtop.aliexpress.checkout.adjustorder'))) {
            this.addEventListener('load', function () {
                try {
                    console.log(`%c[INTERCEPTED XHR] ${this._url}`, 'background:#007bff;color:#fff;padding:2px 5px;border-radius:3px;');
                    processCheckoutData(JSON.parse(this.responseText));
                } catch (e) { console.error('[AE Optimizer] Erro ao parsear XHR:', e); }
            });
        }
        return originalXHRsend.apply(this, arguments);
    };
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const res = await originalFetch(...args);
        const urlString = (args[0] instanceof Request) ? args[0].url : args[0];
        if (typeof urlString === 'string' && (urlString.toLowerCase().includes('mtop.aliexpress.checkout.renderorder') || urlString.toLowerCase().includes('mtop.aliexpress.checkout.adjustorder'))) {
            console.log(`%c[INTERCEPTED FETCH] ${urlString}`, 'background:#28a745;color:#fff;padding:2px 5px;border-radius:3px;');
            try {
                processCheckoutData(await res.clone().json());
            } catch (e) { console.error('[AE Optimizer] Erro ao parsear fetch:', e); }
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

    // --- Currency Check ---
    function checkCurrency() {
        if (!checkoutApiData) return { isUSD: false, currency: 'unknown' };

        // Look for any product with currency information
        for (const [key, block] of Object.entries(checkoutApiData)) {
            if (block?.type === 'pc_checkout_product' && block.fields?.prices?.children?.retailPrice?.currency) {
                const currency = block.fields.prices.children.retailPrice.currency;
                return { isUSD: currency === 'USD', currency };
            }
        }
        return { isUSD: false, currency: 'unknown' };
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
            findInsertBeforeNode().parentNode.insertBefore(container, findInsertBeforeNode());
        }
        return container;
    }

    function addStyles() {
        if (!document.getElementById('custom-split-applier-styles')) {
            document.head.insertAdjacentHTML('beforeend', `
            <style id="custom-split-applier-styles">
              #${OPTIMIZATION_CONTAINER_ID} h5.seller-subheader{margin-top:12px;margin-bottom:5px;font-size:12px;color:#333;border-top:1px solid #eee;padding-top:10px;font-weight:bold;}
              #${OPTIMIZATION_CONTAINER_ID} .split-box{border:1px solid #007bff;padding:15px;margin-top:15px;border-radius:8px;background:#f8faff}
              #${OPTIMIZATION_CONTAINER_ID} .split-box h4{margin-top:0;margin-bottom:8px;color:#0056b3;font-size:16px}
              #${OPTIMIZATION_CONTAINER_ID} .split-box p{margin:4px 0;font-size:13px; color: #555;}
              #${OPTIMIZATION_CONTAINER_ID} .split-box p.tax-breakdown{font-size:11px; color: #777; margin-top: -2px;}
              #${OPTIMIZATION_CONTAINER_ID} .split-item-list{list-style-type:none;padding-left:10px;margin-top:8px;margin-bottom:0}
            </style>`);
        }
    }

    function buildSummaryHtml(totalEstimatedTax, originalTax, strategy) {
        const savings = originalTax - totalEstimatedTax;
        const savingsColor = savings > MINIMUM_SAVINGS_THRESHOLD ? '#27ae60' : '#555';
        const label = savings > MINIMUM_SAVINGS_THRESHOLD ? 'Economia' : 'Economia Est.';
        return `
      <h2 style="margin-top:0;margin-bottom:15px;font-size:18px;color:#333;border-bottom:1px solid #eee;padding-bottom:10px;">📈 Sugestões para Dividir Pedido</h2>
      <ul style="list-style:none;padding:0;margin:0 0 20px 0;font-size:14px;line-height:2.0;">
        <li>Imposto Atual (Pedido Único): <strong style="color:#c0392b;">US $${originalTax.toFixed(2)}</strong></li>
        <li style="padding:8px 0;"><hr style="border:0;border-top:1px solid #eee;"></li>
        <li style="font-size:12px; color:#666;">Usando estratégia de <b>${strategy}</b> com base nas regras do Remessa Conforme.</li>
        <li>Imposto Est. com Divisões: <strong style="color:${savingsColor};">US $${totalEstimatedTax.toFixed(2)}</strong></li>
        <li style="font-weight:bold;">${label}: <strong style="color:${savingsColor};font-size:15px;">US $${savings.toFixed(2)}</strong></li>
      </ul>`;
    }

    function buildFullSuggestionHtml(checkoutPasses, totalEstimatedTax, originalTax, strategy) {
        let html = buildSummaryHtml(totalEstimatedTax, originalTax, strategy);
        html += `<div style="margin-top:15px;margin-bottom:25px;text-align:center;"><button id="goToCartBtn" style="padding:10px 20px;background:#f0ad4e;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;font-weight:bold;">🛒 Ir para o Carrinho para Aplicar</button></div>`;

        html += `<h3>Passos de Compra Sugeridos:</h3>`;
        checkoutPasses.forEach((splitsInPass, index) => {
            const passSubtotal = splitsInPass.reduce((sum, s) => sum + s.subtotal, 0);
            const passTax = splitsInPass.reduce((sum, s) => sum + s.estimatedTax, 0);

            html += `<div class="split-box"><h4>Passo de Compra ${index + 1}</h4>
                     <p>Subtotal do Passo: <strong>US $${passSubtotal.toFixed(2)}</strong></p>
                     <p>Imposto Est. do Passo: <strong>US $${passTax.toFixed(2)}</strong></p>`;

            splitsInPass.forEach(split => {
                html += `<h5 class="seller-subheader">Do vendedor: ${split.sellerName}</h5>
                         <p class="tax-breakdown" style="margin-left:10px;">Imposto do sub-pedido: US $${split.estimatedTax.toFixed(2)} (I.I: $${split.taxDetails.importTax.toFixed(2)}, ICMS: $${split.taxDetails.icmsTax.toFixed(2)})</p>
                         <ul class="split-item-list">`;
                split.items.forEach(it => {
                    html += `<li>${it.quantity} × <a href="${it.itemUrl}" target="_blank" title="${it.displayName}">${it.displayName}</a></li>`;
                });
                html += `</ul>`;
            });
            html += `</div>`;
        });
        return html;
    }

    function displayNoSplitsPossibleUI() {
        const container = ensureContainer();
        container.innerHTML = `<p style="margin: 0; font-size: 14px; color: #555;">⚠️ Este pedido contém apenas um único item, então nenhuma otimização é possível.</p>`;
        localStorage.removeItem(SPLIT_DATA_KEY);
    }

    function displayNoSignificantSavingsUI(originalTax, estimatedSplitTax) {
        const container = ensureContainer();
        container.innerHTML = `
            <p style="margin: 0; font-size: 14px; color: #555;">
                💡 Este pedido já está bem otimizado.
                <br><br>
                Dividir este pedido resultaria em uma economia insignificante de <strong>US $${(originalTax - estimatedSplitTax).toFixed(2)}</strong>.
                <br><br>
                Imposto Atual: <strong style="color: #c0392b;">US $${originalTax.toFixed(2)}</strong>
            </p>`;
        localStorage.removeItem(SPLIT_DATA_KEY);
    }

    function displaySubOrderWarningUI() {
        const container = ensureContainer();
        container.innerHTML = `<p style="margin: 0 0 10px 0; font-size: 14px; color: #154360;">📝 Parece que você está finalizando um pedido parcial de um plano anterior.</p><button id="resetAndRecalculateBtn" style="background-color: #3498db; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">Recalcular para este Pedido</button>`;
        document.getElementById('resetAndRecalculateBtn')?.addEventListener('click', () => {
            localStorage.removeItem(SPLIT_DATA_KEY);
            runOptimization();
        });
    }

    function displayOptimizationSuggestions(splitsData, originalTax, cartFingerprint) {
        addStyles();
        const container = ensureContainer();

        const ordersBySeller = splitsData.splits.reduce((acc, split) => {
            if (!acc[split.sellerName]) acc[split.sellerName] = [];
            acc[split.sellerName].push(split);
            return acc;
        }, {});

        const checkoutPasses = [];
        const maxPasses = Math.max(0, ...Object.values(ordersBySeller).map(s => s.length));
        for (let i = 0; i < maxPasses; i++) {
            const currentPass = [];
            Object.values(ordersBySeller).forEach(sellerSplits => {
                if (sellerSplits[i]) {
                    currentPass.push(sellerSplits[i]);
                }
            });
            checkoutPasses.push(currentPass);
        }

        const payload = {
            checkoutPasses, originalTax, originalCartFingerprint: cartFingerprint,
            totalEstimatedTax: splitsData.totalEstimatedTax, strategy: splitsData.strategy,
        };
        localStorage.setItem(SPLIT_DATA_KEY, JSON.stringify(payload));

        container.innerHTML = buildFullSuggestionHtml(checkoutPasses, splitsData.totalEstimatedTax, originalTax, splitsData.strategy);
        document.getElementById('goToCartBtn')?.addEventListener('click', () => window.open('https://www.aliexpress.com/p/shoppingcart/index.html', '_blank'));
    }

    // --- Orquestrador ---
    function runOptimization() {
        if (!checkoutApiData) return;
        const groupedBySeller = parseCartItems();
        const totalUnits = Array.from(groupedBySeller.values()).flat().reduce((sum, item) => sum + item.quantity, 0);

        if (totalUnits === 0) { console.error("[AE Optimizer] Nenhum item encontrado no carrinho após o parsing."); return; }

        const fingerprint = generateCartFingerprint(groupedBySeller);
        const savedData = JSON.parse(localStorage.getItem(SPLIT_DATA_KEY) || '{}');
        if (savedData.originalCartFingerprint && savedData.originalCartFingerprint !== fingerprint) {
            displaySubOrderWarningUI();
            return;
        }

        const summary = calculateTaxValues();
        if (!summary) { console.error("[AE Optimizer] Não foi possível calcular os valores dos impostos."); return; }
        const { taxAmount } = summary;

        if (totalUnits <= 1) {
            displayNoSplitsPossibleUI();
            return;
        }

        const splitsData = suggestSplits(groupedBySeller);
        const savings = taxAmount - splitsData.totalEstimatedTax;

        if (savings < MINIMUM_SAVINGS_THRESHOLD) {
            displayNoSignificantSavingsUI(taxAmount, splitsData.totalEstimatedTax);
        } else {
            displayOptimizationSuggestions(splitsData, taxAmount, fingerprint);
        }
    }
})();
