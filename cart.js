// ==UserScript==
// @name         ALICATE - Cart Split Applier
// @namespace    http://tampermonkey.net/
// @version      2025-11-05-cart-v13
// @description  Reads the order split plan from the ALICATE Checkout Optimizer and provides a UI to apply them in your cart.
// @author       @esauvisky
// @match        https://www.aliexpress.com/p/shoppingcart/index.html*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=aliexpress.com
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    const LOADER_SELECTOR = '.comet-v2-loading-wrap, .cart-list-placeholder-loading';
    const SELECT_ALL_SELECTOR = '.cart-header-checkbox-wrap label.comet-v2-checkbox';
    const SPLIT_DATA_KEY = 'aliExpressCartSplits';
    const UI_CONTAINER_ID = 'cart-split-applier-ui';

    function setReactInputValue(element, value) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(element, value);
        const inputEvent = new Event('input', { bubbles: true });
        element.dispatchEvent(inputEvent);
        const blurEvent = new Event('blur', { bubbles: true });
        element.dispatchEvent(blurEvent);
    }

    function waitForLoadingToFinish(customTimeout = 3000) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                observer.disconnect();
                console.warn(`waitForLoadingToFinish timed out after ${customTimeout}ms. Continuing anyway.`);
                resolve();
            }, customTimeout);

            const observer = new MutationObserver(() => {
                if (!document.querySelector(LOADER_SELECTOR)) {
                    clearTimeout(timeout);
                    observer.disconnect();
                    setTimeout(resolve, 150);
                }
            });

            if (!document.querySelector(LOADER_SELECTOR)) {
                clearTimeout(timeout);
                setTimeout(resolve, 150);
            } else {
                observer.observe(document.body, { childList: true, subtree: true });
            }
        });
    }

    function showNotification(message, type = 'success', duration = 12000) {
        const notificationArea = document.querySelector(`#${UI_CONTAINER_ID} .split-tool-notification`);
        if (!notificationArea) return;
        notificationArea.innerHTML = message;
        notificationArea.className = `split-tool-notification ${type}`;
        notificationArea.style.display = 'block';
        setTimeout(() => { notificationArea.style.display = 'none'; }, duration);
    }

    function parseCartPageItems() {
        const items = [];
        document.querySelectorAll('div.cart-product.activity_cart_product').forEach(productEl => {
            const linkEl = productEl.querySelector('a.cart-product-name-title');
            const href = linkEl?.href;
            const itemIdMatch = href ? href.match(/item\/(\d+)\.html/) : null;
            if (!itemIdMatch) return;

            items.push({
                itemId: itemIdMatch[1],
                checkbox: productEl.querySelector('label.comet-v2-checkbox'),
                quantityInput: productEl.querySelector('.comet-v2-input-number-input'),
            });
        });
        return items;
    }

    async function applyPass(passIndex, allPasses, allButtons) {
        allButtons.forEach(b => { b.disabled = true; b.style.cursor = 'wait'; b.style.opacity = '0.7'; });
        const clickedButton = allButtons[passIndex];
        const originalText = clickedButton.innerHTML;

        try {
            clickedButton.innerHTML = '🔄 Preparando...';
            const itemsToProcess = allPasses[passIndex].flatMap(split => split.items).map(item => ({
                ...item,
                itemId: (item.itemUrl.match(/item\/(\d+)\.html/) || [])[1]
            })).filter(item => item.itemId);

            const currentlyVisibleItems = parseCartPageItems();
            const pageItemIds = new Set(currentlyVisibleItems.map(item => item.itemId));
            const missingItems = itemsToProcess.filter(itemToFind => !pageItemIds.has(itemToFind.itemId));

            if (missingItems.length > 0) {
                const missingItemsList = missingItems
                    .map(item => `<li>${item.quantity}x <a href="${item.itemUrl}" target="_blank">${item.displayName}</a></li>`)
                    .join('');
                showNotification(`<b>Erro: Itens não encontrados!</b><br>Os seguintes itens do plano não estão no seu carrinho. Por favor, adicione-os e tente novamente:<ul>${missingItemsList}</ul>`, 'error', 20000);
                return; // Stop execution
            }

            const selectAllCheckbox = document.querySelector(SELECT_ALL_SELECTOR);
            if (!selectAllCheckbox) throw new Error("Não foi possível encontrar a caixa 'Selecionar Todos'.");
            if (document.querySelector('.cart-product .comet-v2-checkbox-checked')) {
                 if (!selectAllCheckbox.classList.contains('comet-v2-checkbox-checked')) { selectAllCheckbox.click(); await waitForLoadingToFinish(); }
                 selectAllCheckbox.click(); await waitForLoadingToFinish();
            }

            clickedButton.innerHTML = `🔍 Aplicando Passe ${passIndex + 1}...`;

            let scrollAttempts = 0;
            const MAX_SCROLL_ATTEMPTS = 20;
            let totalSelectedUnits = 0;
            let itemsToProcessInLoop = [...itemsToProcess];

            while (itemsToProcessInLoop.length > 0 && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
                let itemsFoundInThisPass = false;
                const visibleItemsNow = parseCartPageItems();

                for (let i = itemsToProcessInLoop.length - 1; i >= 0; i--) {
                    const itemToFind = itemsToProcessInLoop[i];
                    const foundOnPage = visibleItemsNow.find(pItem => pItem.itemId === itemToFind.itemId);

                    if (foundOnPage) {
                        itemsFoundInThisPass = true;
                        const currentQuantity = parseInt(foundOnPage.quantityInput.value, 10);
                        const neededQuantity = itemToFind.quantity;

                        if (currentQuantity !== neededQuantity) {
                            console.log(`Adjusting quantity for item ${itemToFind.itemId} from ${currentQuantity} to ${neededQuantity}`);
                            setReactInputValue(foundOnPage.quantityInput, neededQuantity);
                            await waitForLoadingToFinish().catch(e => console.warn(`Timeout after quantity adjustment: ${e.message}`));
                        }

                        if (foundOnPage.checkbox && !foundOnPage.checkbox.classList.contains('comet-v2-checkbox-checked')) {
                            foundOnPage.checkbox.click();
                            await waitForLoadingToFinish(1500).catch(e => console.warn(`Timeout after selection: ${e.message}`));
                        }

                        totalSelectedUnits += neededQuantity;
                        itemsToProcessInLoop.splice(i, 1);
                    }
                }

                if (itemsToProcessInLoop.length > 0) {
                    const initialHeight = document.documentElement.scrollHeight;
                    window.scrollTo(0, initialHeight);
                    await new Promise(r => setTimeout(r, 1500));
                    if (document.documentElement.scrollHeight === initialHeight && !itemsFoundInThisPass) break;
                }
                scrollAttempts++;
            }

            showNotification(`✅ Passe ${passIndex + 1} aplicado. Foram selecionadas ${totalSelectedUnits} unidades no total. Por favor, verifique e finalize a compra.`, 'success');

        } catch (error) {
            console.error("Error applying pass:", error);
            showNotification(`Erro: ${error.message}.`, 'error');
        } finally {
            allButtons.forEach(b => { b.disabled = false; b.style.cursor = 'pointer'; b.style.opacity = '1'; });
            clickedButton.innerHTML = originalText;
        }
    }

    // --- UI Creation and Styling ---

    function createUI(splitsData) {
        if (document.getElementById(UI_CONTAINER_ID)) {
            document.getElementById(UI_CONTAINER_ID).remove();
        }
        const container = document.createElement('div');
        container.id = UI_CONTAINER_ID;

        const { splits, totalEstimatedTax, originalTax, quantityWarnings = [] } = splitsData;
        const savings = (originalTax || 0) - (totalEstimatedTax || 0);
        const hasQuantityWarnings = quantityWarnings.length > 0;

        let html = `
            <div class="split-tool-title">Split Order Tool</div>
            <div class="split-tool-content">
                <div class="split-tool-info">
                    Potential Savings: <strong style="color: ${savings >= 0 ? '#27ae60' : '#c0392b'};">US $${savings.toFixed(2)}</strong>
                </div>`;

        // Add quantity warning section if needed
        if (hasQuantityWarnings) {
            html += `
                <div class="split-tool-warning">
                    ⚠️ <strong>Quantity Splits Required:</strong> Some items need to be split across multiple orders.
                    <details style="margin-top: 8px;">
                        <summary style="cursor: pointer; color: #e67e22;">View Details</summary>
                        <ul style="margin: 8px 0 0 20px; font-size: 12px;">`;

            quantityWarnings.forEach(warning => {
                const distributions = warning.splitDistribution.map(dist =>
                    `Split ${dist.splitIndex + 1}: ${dist.count}x`
                ).join(', ');
                html += `<li>${warning.displayName}${warning.originalSkuText ? ` (${warning.originalSkuText})` : ''} - ${distributions}</li>`;
            });

            html += `
                        </ul>
                    </details>
                </div>`;
        }

        html += `<div class="split-applier-buttons">`;

        splits.forEach((split, index) => {
            const itemCount = split.items.length;

            // --- Popup Content Generation ---
            const itemCounts = {};
            split.items.forEach(item => {
                const key = `${item.displayName}|${item.originalSkuText}`;
                if (!itemCounts[key]) itemCounts[key] = { ...item, count: 0 };
                itemCounts[key].count++;
            });

            let popupHtml = `<div class="split-hover-popup"><h4>Items in Split ${index + 1}</h4><ul>`;
            for (const key in itemCounts) {
                const item = itemCounts[key];
                popupHtml += `<li>
                                <span class="item-count">${item.count} &times;</span>
                                <a href="${item.itemUrl}" target="_blank" title="${item.displayName} - ${item.originalSkuText || ''}">
                                    ${item.displayName}
                                    ${item.originalSkuText ? `<span class="item-sku">(${item.originalSkuText})</span>` : ''}
                                </a>
                              </li>`;
            }
            popupHtml += `</ul></div>`;

            // --- Button and Wrapper HTML ---
            html += `<div class="split-button-wrapper">
                        <button class="split-button" data-split-index="${index}">
                            Apply Split ${index + 1}
                            <span class="split-details">${itemCount} item(s) - US $${split.subtotal.toFixed(2)}</span>
                        </button>
                        ${popupHtml}
                     </div>`;
        });
        html += `   </div>
                <div class="split-tool-notification" style="display: none;"></div>
                <div class="split-tool-footer">
                    <button id="clear-splits-data" title="Clear split data and remove this tool">Clear & Close</button>
                </div>
            </div>`;
        container.innerHTML = html;

        const checkoutBox = document.querySelector('.cart-summary');
        if (checkoutBox) {
            checkoutBox.prepend(container);
        } else {
            container.style.cssText = 'position: fixed; top: 150px; right: 20px; z-index: 9999;';
            document.body.appendChild(container);
        }

        const allButtons = Array.from(container.querySelectorAll('.split-button'));
        allButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.splitIndex, 10);
                applySplit(index, splits, allButtons, quantityWarnings);
            });
        });
        container.querySelector('#clear-splits-data').addEventListener('click', () => {
            localStorage.removeItem(SPLIT_DATA_KEY);
            container.remove();
        });
    }

    GM_addStyle(`
        #${UI_CONTAINER_ID} {
            background-color: #fff; border: 1px solid #eaeaec; padding: 16px; margin-bottom: 16px; border-radius: 12px;
        }
        .split-tool-title {
            font-size: 16px; font-weight: 700; color: #191919; padding-bottom: 12px;
            margin-bottom: 12px; border-bottom: 1px solid #f2f2f2; text-align: center;
        }
        .split-tool-info { font-size: 14px; color: #666; margin-bottom: 16px; text-align: center; }
        .split-tool-info strong { font-weight: 700; }
        .split-tool-warning {
            background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404;
            padding: 12px; margin-bottom: 16px; border-radius: 6px; font-size: 13px;
        }
        .split-tool-warning strong { color: #d68910; }
        .split-applier-buttons { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; justify-content: center; }
        .split-button {
            width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
            padding: 8px; background-color: #f5f5f5; color: #333; border: 1px solid #ddd; border-radius: 8px;
            cursor: pointer; font-size: 14px; font-weight: 500; text-align: center;
            transition: all 0.2s ease-in-out; line-height: 1.3;
        }
        .split-button:hover:not(:disabled) { background-color: #e9e9e9; border-color: #ccc; transform: translateY(-1px); }
        .split-details { font-size: 11px; color: #777; margin-top: 4px; font-weight: 400; }
        .split-tool-notification {
            padding: 10px; margin-top: 15px; border-radius: 8px; font-size: 13px;
            font-weight: 500; text-align: center;
        }
        .split-tool-notification.success { background-color: #e8f5e9; color: #2e7d32; }
        .split-tool-notification.error { background-color: #ffebee; color: #c62828; }
        .split-tool-notification ul { text-align: left; margin: 5px 0 0 20px; }
        .split-tool-footer { text-align: center; margin-top: 12px; }
        #clear-splits-data {
            background: none; border: none; color: #999; padding: 4px 8px;
            font-size: 12px; border-radius: 4px; cursor: pointer; text-decoration: underline;
        }
        #clear-splits-data:hover { color: #333; }

        /* --- NEW STYLES for Hover Popup --- */
        .split-button-wrapper { position: relative; }
        .split-hover-popup {
            visibility: hidden; opacity: 0; position: absolute; background-color: #2c3e50;
            color: #ecf0f1; padding: 12px; border-radius: 8px; box-shadow: 0 5px 15px rgba(0, 0, 0, 0.4);
            z-index: 100; width: 320px; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
            transition: opacity 0.25s ease-in-out, visibility 0.25s ease-in-out; pointer-events: none;
        }
        .split-button-wrapper:hover .split-hover-popup { visibility: visible; opacity: 1; pointer-events: auto; }
        .split-hover-popup h4 {
            margin: 0 0 10px 0; font-size: 14px; font-weight: 600; color: #fff;
            padding-bottom: 6px; border-bottom: 1px solid #4a627a;
        }
        .split-hover-popup ul { list-style: none; padding: 0; margin: 0; max-height: 250px; overflow-y: auto; }
        .split-hover-popup ul::-webkit-scrollbar { width: 5px; }
        .split-hover-popup ul::-webkit-scrollbar-track { background: #34495e; }
        .split-hover-popup ul::-webkit-scrollbar-thumb { background: #7f8c8d; border-radius: 3px;}
        .split-hover-popup li { font-size: 12px; display: flex; align-items: flex-start; margin-bottom: 6px; }
        .split-hover-popup .item-count { color: #bdc3c7; margin-right: 8px; font-weight: bold; flex-shrink: 0; }
        .split-hover-popup a { color: #5dade2; text-decoration: none; line-height: 1.3; }
        .split-hover-popup a:hover { color: #85c1e9; text-decoration: underline; }
        .split-hover-popup .item-sku { display: block; color: #95a5a6; font-size: 11px; margin-top: 2px; }
    `);

    // --- Initialization ---

    function init() {
        const savedData = localStorage.getItem(SPLIT_DATA_KEY);
        if (savedData) {
            try {
                const splitsData = JSON.parse(savedData);
                if (splitsData?.splits?.length > 0) createUI(splitsData);
            } catch (e) {
                console.error('Failed to parse split data. Removing corrupted data.', e);
                localStorage.removeItem(SPLIT_DATA_KEY);
            }
        }
    }

    const observer = new MutationObserver((mutations) => {
        for(const mutation of mutations) {
            if (mutation.addedNodes.length) {
                if (document.querySelector('.cart-summary') && !document.getElementById(UI_CONTAINER_ID)) {
                    init();
                    break;
                }
            }
        }
    });

    window.addEventListener('load', () => {
        init();
        observer.observe(document.body, { childList: true, subtree: true });
    });
})();
