// ==UserScript==
// @name         Mindful Browsing - Box Breathing (Optimized)
// @namespace    mindful.elegant.solid
// @version      23.0
// @description  60s strict timer. Optimized performance with reduced polling and memory leak fixes.
// @author       You
// @match        *://*.youtube.com/*
// @match        *://youtube.com/*
// @match        *://*.facebook.com/*
// @match        *://facebook.com/*
// @match        *://*.instagram.com/*
// @match        *://instagram.com/*
// @match        *://*.twitter.com/*
// @match        *://twitter.com/*
// @match        *://*.x.com/*
// @match        *://x.com/*
// @match        *://*.tiktok.com/*
// @match        *://tiktok.com/*
// @match        *://*.reddit.com/*
// @match        *://reddit.com/*
// @match        *://*.lapresse.ca/*
// @match        *://*.theverge.com/*
// @match        *://*.polygon.com/*
// @match        *://*.theguardian.com/*
// @match        *://news.ycombinator.com/*
// @match        *://aeon.co/*
// @match        *://*.rottentomatoes.com/*
// @match        *://news.google.com/*
// @match        *://*.cnn.com/*
// @match        *://cnn.com/*
// @match        *://*.bbc.com/*
// @match        *://*.nytimes.com/*
// @match        *://*.washingtonpost.com/*
// @match        *://*.netflix.com/*
// @match        *://netflix.com/*
// @match        *://*.hulu.com/*
// @match        *://hulu.com/*
// @match        *://*.disneyplus.com/*
// @match        *://disneyplus.com/*
// @match        *://*.primevideo.com/*
// @match        *://*.buzzfeed.com/*
// @match        *://*.amazon.com/*
// @match        *://amazon.com/*
// @match        *://*.ebay.com/*
// @match        *://ebay.com/*
// @match        *://*.bestbuy.com/*
// @match        *://bestbuy.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-start
// @noframes
// ==/UserScript==

(() => {
    'use strict';

    const MAX_UNLOCKS = 2;
    const SESSION_MINS = 30;
    const PHASE_TIME = 5000;

    const COLORS = {
        bgStart: '#5c6bc0',
        bgEnd: '#3f51b5',
        bgHoldStart: '#303f9f',
        bgHoldEnd: '#1a237e',
        cardBg: 'rgba(255, 255, 255, 0.12)',
        circleBg: 'rgba(255, 255, 255, 0.25)',
        circleHoldBg: 'rgba(26, 35, 126, 0.6)',
        buttonBg: 'rgba(255, 255, 255, 0.2)',
    };

    const sessionKey = `mindful_global_session`;
    const dailyKey = `mindful_global_count`;

    // Storage Wrapper
    const safeGM = {
        getValue: (key, def) => {
            if (typeof GM_getValue !== 'undefined') return GM_getValue(key, def);
            try {
                const val = localStorage.getItem(key);
                return val ? JSON.parse(val) : def;
            } catch (e) { return def; }
        },
        setValue: (key, val) => {
            if (typeof GM_setValue !== 'undefined') return GM_setValue(key, val);
            try {
                localStorage.setItem(key, JSON.stringify(val));
            } catch (e) { }
        },
        deleteValue: (key) => {
            if (typeof GM_deleteValue !== 'undefined') return GM_deleteValue(key);
            try {
                localStorage.removeItem(key);
            } catch (e) { }
        }
    };

    // Improved sanitizer with fallback
    let sanitizer = (val) => val;
    try {
        if (window.trustedTypes && window.trustedTypes.createPolicy) {
            const policy = window.trustedTypes.createPolicy('mindfulPolicy', { createHTML: (s) => s });
            sanitizer = (val) => policy.createHTML(val);
        }
    } catch (e) {
        console.warn('Mindful: TrustedTypes not available, using default sanitizer');
    }

    const getStats = () => {
        const d = safeGM.getValue(dailyKey, null);
        return (d && d.date === new Date().toDateString()) ? d : { count: 0, date: new Date().toDateString() };
    };

    const isUnlocked = () => {
        const last = safeGM.getValue(sessionKey, null);
        return last && (Date.now() - last < SESSION_MINS * 60000);
    };

    const injectStyles = () => {
        if (document.getElementById('mindful-styles')) return;
        const s = document.createElement('style');
        s.id = 'mindful-styles';
        s.textContent = `
            #mindful-overlay {
                position: fixed !important; top: 0 !important; left: 0 !important; 
                width: 100vw !important; height: 100vh !important;
                background: linear-gradient(135deg, ${COLORS.bgStart}, ${COLORS.bgEnd}) !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                z-index: 2147483647 !important; color: white !important; font-family: sans-serif !important;
                transition: background 1.5s ease-in-out !important;
            }
            #mindful-overlay.hold-active {
                background: linear-gradient(135deg, ${COLORS.bgHoldStart}, ${COLORS.bgHoldEnd}) !important;
            }
            .m-card {
                background: ${COLORS.cardBg} !important;
                padding: 3rem 2.5rem !important;
                border-radius: 32px !important;
                backdrop-filter: blur(20px) !important;
                -webkit-backdrop-filter: blur(20px) !important;
                border: 1px solid rgba(255, 255, 255, 0.15) !important;
                width: 440px !important; text-align: center !important;
                box-shadow: 0 20px 50px rgba(0,0,0,0.15) !important;
            }
            .m-title { font-size: 2.2rem !important; font-weight: 700 !important; margin-bottom: 0.5rem !important; }
            .m-sub { font-size: 1.1rem !important; opacity: 0.8 !important; margin-bottom: 2rem !important; }
            
            .b-box { 
                width: 200px !important; height: 200px !important; margin: 0 auto 1.5rem !important; 
                position: relative !important; display: flex !important; align-items: center !important; justify-content: center !important; 
            }
            .b-sq { 
                position: absolute !important; width: 100% !important; height: 100% !important; 
                border: 1.5px solid rgba(255, 255, 255, 0.3) !important; 
            }
            .b-circle { 
                width: 90px !important; height: 90px !important; background: ${COLORS.circleBg} !important; 
                border-radius: 50% !important; transition: transform 5s cubic-bezier(0.4, 0, 0.2, 1), background 1.5s ease !important; 
            }
            .b-circle.hold-circle { background: ${COLORS.circleHoldBg} !important; }
            .b-dot { 
                position: absolute !important; width: 14px !important; height: 14px !important; background: white !important; border-radius: 50% !important; 
                box-shadow: 0 0 10px white !important; top: -7px !important; left: -7px !important; 
                offset-path: rect(0% 100% 100% 0%) !important; 
            }

            .m-status { font-size: 1.2rem !important; font-weight: 500 !important; margin-bottom: 2rem !important; height: 1.5rem !important; }
            
            .m-btn { 
                background: ${COLORS.buttonBg} !important; color: white !important; border: none !important; 
                padding: 1rem 0 !important; width: 220px !important; border-radius: 18px !important; 
                font-weight: 700 !important; cursor: pointer !important; font-size: 1.2rem !important;
                transition: background 0.3s !important;
            }
            .m-btn:disabled { opacity: 0.8 !important; cursor: default !important; }
            
            .intentions { 
                margin-top: 2rem !important; padding-top: 1.5rem !important; border-top: 1px solid rgba(255, 255, 255, 0.1) !important; 
                font-size: 0.9rem !important; opacity: 0.7 !important; cursor: pointer !important;
                transition: opacity 0.2s !important;
            }
            .intentions:hover { opacity: 0.9 !important; }

            #mindful-lock-bar {
                position: fixed !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 40px !important;
                background: linear-gradient(135deg, ${COLORS.bgStart}, ${COLORS.bgEnd}) !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                color: white !important; font-size: 13px !important; font-weight: 600 !important; cursor: pointer !important; z-index: 2147483646 !important;
                border-bottom: 1px solid rgba(255,255,255,0.2) !important; backdrop-filter: blur(10px) !important;
                transition: background 0.2s !important;
            }
            #mindful-lock-bar:hover {
                background: linear-gradient(135deg, ${COLORS.bgHoldStart}, ${COLORS.bgHoldEnd}) !important;
            }
            @keyframes follow { from { offset-distance: 0%; } to { offset-distance: 100%; } }
        `;
        document.documentElement.appendChild(s);
    };

    function renderUI() {
        if (isUnlocked()) {
            const overlay = document.getElementById('mindful-overlay');
            if (overlay) overlay.remove();
            showRelockBar();
            return;
        }

        if (document.getElementById('mindful-overlay')) return;

        const stats = getStats();
        const overlay = document.createElement('div');
        overlay.id = 'mindful-overlay';

        let content = '';
        if (stats.count >= MAX_UNLOCKS) {
            content = `<div class="m-card"><div class="m-title">Daily Limit Reached</div><div class="m-sub">You've used ${MAX_UNLOCKS} unlocks today. See you tomorrow.</div></div>`;
        } else {
            content = `
                <div class="m-card">
                    <div class="m-title">Take a Mindful Moment</div>
                    <div class="m-sub">Unlock ${stats.count + 1} of ${MAX_UNLOCKS} today</div>
                    <div class="b-box">
                        <div class="b-sq"></div>
                        <div class="b-dot" id="m-dot"></div>
                        <div class="b-circle" id="m-circle"></div>
                    </div>
                    <div class="m-status" id="m-status">Breathe In</div>
                    <button class="m-btn" id="m-start">60</button>
                    <div class="intentions" id="m-intentions">What's your intention?</div>
                </div>`;
        }

        overlay.innerHTML = sanitizer(content);
        document.documentElement.appendChild(overlay);

        if (stats.count < MAX_UNLOCKS) {
            const btn = document.getElementById('m-start');
            const circle = document.getElementById('m-circle');
            const dot = document.getElementById('m-dot');
            const status = document.getElementById('m-status');
            const overlayEl = document.getElementById('mindful-overlay');
            const intentions = document.getElementById('m-intentions');

            // Simple intentions prompt
            if (intentions) {
                intentions.onclick = () => {
                    const intent = prompt("Before you proceed, what's your intention for visiting this site?\n\nExamples:\n• Check one specific thing\n• Respond to a message\n• 10 minutes of mindful browsing\n\nType your intention:");
                    if (intent) {
                        intentions.textContent = `💭 "${intent.substring(0, 50)}${intent.length > 50 ? '...' : ''}"`;
                        intentions.style.opacity = '0.9';
                    }
                };
            }

            btn.onclick = () => {
                btn.disabled = true;
                let c = 0;
                let sec = 60;

                const timerInterval = setInterval(() => {
                    if (sec > 0) {
                        btn.textContent = --sec;
                    } else {
                        clearInterval(timerInterval);
                    }
                }, 1000);

                const loop = () => {
                    if (c >= 3 || sec <= 0) {
                        clearInterval(timerInterval);
                        dot.style.animation = 'none';
                        status.textContent = "Session Complete";
                        btn.disabled = false;
                        btn.textContent = "Visit Website";
                        btn.onclick = () => {
                            stats.count++;
                            safeGM.setValue(dailyKey, stats);
                            safeGM.setValue(sessionKey, Date.now());
                            window.location.replace(window.location.href);
                        };
                        return;
                    }
                    dot.style.animation = `follow ${PHASE_TIME * 4}ms linear infinite`;

                    // Inhale
                    status.textContent = "Breathe In";
                    circle.style.transform = "scale(2.1)";
                    overlayEl.classList.remove('hold-active');
                    circle.classList.remove('hold-circle');

                    setTimeout(() => {
                        // Hold
                        status.textContent = "Hold";
                        overlayEl.classList.add('hold-active');
                        circle.classList.add('hold-circle');

                        setTimeout(() => {
                            // Exhale
                            status.textContent = "Breathe Out";
                            circle.style.transform = "scale(1)";
                            overlayEl.classList.remove('hold-active');
                            circle.classList.remove('hold-circle');

                            setTimeout(() => {
                                // Hold
                                status.textContent = "Hold";
                                overlayEl.classList.add('hold-active');
                                circle.classList.add('hold-circle');

                                setTimeout(() => { c++; loop(); }, PHASE_TIME);
                            }, PHASE_TIME);
                        }, PHASE_TIME);
                    }, PHASE_TIME);
                };
                loop();
            };
        }
    }

    // Fixed memory leak - store interval ID and clear on recreate
    let relockInterval = null;
    function showRelockBar() {
        if (document.getElementById('mindful-lock-bar')) return;

        const bar = document.createElement('div');
        bar.id = 'mindful-lock-bar';

        const update = () => {
            const last = safeGM.getValue(sessionKey, 0);
            const remaining = (SESSION_MINS * 60000) - (Date.now() - last);
            if (remaining <= 0) {
                if (relockInterval) clearInterval(relockInterval);
                safeGM.deleteValue(sessionKey);
                window.location.replace(window.location.href);
                return;
            }
            const mins = Math.floor(remaining / 60000);
            const secs = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
            bar.textContent = `🔓 Mindful Session Active • ${mins}:${secs} left • Click to re-lock`;
        };

        relockInterval = setInterval(update, 1000);
        update();

        bar.onclick = () => {
            if (relockInterval) clearInterval(relockInterval);
            safeGM.deleteValue(sessionKey);
            window.location.replace(window.location.href);
        };

        document.documentElement.prepend(bar);
        document.documentElement.style.setProperty('padding-top', '40px', 'important');
    }

    // Initialize
    injectStyles();

    // Much more efficient - check once on load, then only when DOM changes
    const checkAndRender = () => {
        if (!isUnlocked()) {
            renderUI();
            if (document.body) document.body.style.setProperty('display', 'none', 'important');
        } else {
            if (document.body) document.body.style.display = '';
            showRelockBar();
        }
    };

    // Initial check
    checkAndRender();

    // Watch for body element appearance (for document-start timing)
    if (!document.body) {
        const observer = new MutationObserver(() => {
            if (document.body) {
                checkAndRender();
                observer.disconnect();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    // Fallback polling (much less frequent) - only needed if something removes our elements
    setInterval(checkAndRender, 2000); // Changed from 100ms to 2000ms (20x reduction)
})();