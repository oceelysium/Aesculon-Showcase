# Æsculon — Medical SBA Revision & Spaced Repetition Platform

Æsculon is a high-fidelity, distraction-free Single Best Answer (SBA) preparation platform designed for medical students. It acts as a comprehensive study workspace, integrating personalized memory retention algorithms, real-time cohort multiplayer arenas, and custom data visualizations.

---

## 🔒 Showcase Repository Scope
> [!IMPORTANT]
> **This repository is a portfolio case study.** 
> To protect proprietary medical question banks and university learning materials, the source code is hosted in a private repository. Access to the full source code (including Flask configurations, SQLAlchemy models, and client-side scripts) can be provided to prospective employers and hiring managers upon request. 

---

## 🌟 Visual Showcase

| **Stoa (Home Dashboard) — Light Theme** | **Stoa (Home Dashboard) — Dark Theme** |
|:---:|:---:|
| ![Light Mode Dashboard](screenshots/stoa_dashboard_light.png) | ![Dark Mode Dashboard](screenshots/stoa_dashboard_dark.png) |
| A classical ivory-textured workspace focusing on daily study targets, active streak counters, and peer leaderboards. | An obsidian-textured low-light theme optimized for late-night study sessions. |

| **Agora (Practice Arena)** | **Progress Analytics & SVG Charts** |
|:---:|:---:|
| ![Practice Screen](screenshots/spaced_repetition_practice.png) | ![Progress Page Charts](screenshots/progress_charts.png) |
| Calmed practice loop featuring active option hover states, detailed anatomical rationale, and reviews. | Custom SVG columns and radar webs that dynamically visualize study effort and accuracy across medical blocks. |

| **Multiplayer Duel Arena** | **Patch Notes / Updates Dialog** |
|:---:|:---:|
| ![Multiplayer Lobby](screenshots/multiplayer_arena.png) | ![Patch Notes Popover](screenshots/patch_notes_modal.png) |
| Active multiplayer room creation, filtering by cohort, and real-time ready-up statuses. | Dynamic floating popover detailing the latest release patch notes, managed directly from an admin panel. |

---

## 🛠️ Product Highlights & Technical Architecture

### 1. Spaced Repetition Engine
At the core of the practice loop is a memory scheduler based on an adapted spaced-repetition algorithm.
* **Interval Calculations**: Calculates optimal intervals for future reviews based on the difficulty of the topic and the user's historical performance.
* **Self-Assessment Feedback**: Translates subjective user confidence metrics (e.g., *Good*, *Bad*, *Not Learnt*) into mathematical modifiers, adjusting ease factors and scheduling intervals dynamically to maximize long-term retention.
* **Data Flow**: Evaluates attempt histories to queue up past questions exactly when they are due, separating active learning from regular review.

### 2. Custom Inline SVG Visualization Engine
To achieve a lightweight footprint and maximum responsiveness, all analytics charts are written using native inline SVG vectors rather than heavy external libraries:
* **XP History Columns**: Computes rolling daily effort metrics, automatically scaling columns and grid lines to fit container boundaries. Features interactive hover triggers that reveal precise XP values.
* **Competency Radar Web**: Maps a multi-variable radar polygon representing accuracy across different medical blocks (e.g., *Musculoskeletal*, *Cardiovascular*, *Respiratory*, *Renal*, *Gastrointestinal*). Optimized using coordinate transformation math and GPU-accelerated CSS properties to prevent jitter.

### 3. Tactile UI & Micro-Animations
The client-side interface is styled from scratch with plain CSS, using modern layout structures and keyframe transitions to create a premium feel:
* **Option Card Selection**: Toggling answers triggers spring-based scaling transitions. Unchosen distractors fade out, and active hovers translate option components to guide visual focus.
* **Dynamic Content Expansion**: Transitions explanation card heights and dialog modals smoothly, avoiding abrupt page layout shifting when answers are submitted.
* **Notification Center**: A notification drawer in the topbar handles real-time polling of announcements and review feedback reports, updating count badges and modal popovers.

### 4. Cohort Multiplayer Arena
Classmates can review together in real-time through private or open lobbies:
* **State Synchronization**: Synchronizes lobby states, active question pools, and ready indicators across all participants.
* **Filter Matching**: Locks questions based on shared filter settings (block, question limits, and mode), gracefully managing edge-cases where the matching question pool is small.

### 5. Admin Control Panel
A lightweight administrator portal enables cohort management and quality control:
* **Question Triage Queue**: Aggregates community ratings on question quality. Admins can review feedback, post replies with source references, and retire low-quality questions.
* **Dynamic Patch Notes**: A database-driven release manager that allows publishing, editing, and deleting patch notes, which instantly feed into the client updates popup.

---

## ⚙️ Core Technology Stack

* **Backend**: Python, Flask, SQLAlchemy, Gunicorn
* **Database**: PostgreSQL (Production), SQLite (Local testing)
* **Frontend**: Vanilla ES6 JavaScript, HTML5, CSS3, Hotwire Turbo (for SPA-like page transitions)
* **Email System**: STARTTLS SMTP integration for secure password resets

---

## 📬 Contact & Code Access
If you are a prospective employer or technical reviewer wishing to inspect the codebase (including implementation details, tests, and database migrations), please contact me directly at **oceelysium@users.noreply.github.com** to request private repository access.
