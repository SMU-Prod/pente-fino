import styles from "./home.module.css";
import { UploadPanel } from "./UploadPanel.js";

/**
 * The front door (§8.2's flow, §13.1's design language).
 *
 * A **server** component. Everything here is static text, so none of it
 * ships JavaScript; `<UploadPanel>` is the one client island, and it holds
 * the file input, the progress bar and the SSE stream.
 *
 * That split is not a preference. With the whole page as a client
 * component, Lighthouse measured an LCP of 2.4 s against RNF-03's 2.0 s —
 * and 81% of it was *render delay*, the main thread hydrating a hero and
 * three paragraphs that never needed hydrating. `laudo/[id]` had already
 * drawn the same line around `<FindingsList>`.
 *
 * Copy note: nothing here promises an outcome. §14.3's forbidden
 * vocabulary (INV-004/INV-005) rules out "garantimos", "você vai receber"
 * and every variant, and the product's own claim is deliberately narrow —
 * it shows what is worth checking, and the person decides.
 */
export default function Home() {
  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>Auditoria de fatura</p>

      <h1 className={styles.headline}>
        Sua conta tem linhas que{" "}
        <span className={styles.marked}>
          ninguém lê
          <svg
            className={styles.markedUnderline}
            viewBox="0 0 200 20"
            fill="none"
            aria-hidden="true"
            preserveAspectRatio="none"
          >
            <path
              d="M4 13c38-7 78-9 118-6 26 2 51 6 74 10"
              stroke="currentColor"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
        .
      </h1>

      <p className={styles.lede}>
        Envie a fatura da sua operadora ou a do cartão. Em segundos você vê,
        linha por linha, o que vale conferir — com o valor de cada item e o
        motivo pelo qual ele apareceu.
      </p>

      <UploadPanel />

      <ol className={styles.steps}>
        <li className={styles.step}>
          <span className={styles.stepNumber}>01</span>
          <h2 className={styles.stepTitle}>Você envia</h2>
          <p className={styles.stepBody}>
            O arquivo vai direto para o armazenamento, sem passar pelo nosso
            servidor. Não pedimos senha nem acesso à sua conta na operadora.
          </p>
        </li>
        <li className={styles.step}>
          <span className={styles.stepNumber}>02</span>
          <h2 className={styles.stepTitle}>A fatura é lida</h2>
          <p className={styles.stepBody}>
            Cada item é separado, somado e comparado com o ciclo anterior.
            CPF, endereço e código de barras são mascarados antes de gravar.
          </p>
        </li>
        <li className={styles.step}>
          <span className={styles.stepNumber}>03</span>
          <h2 className={styles.stepTitle}>Você decide</h2>
          <p className={styles.stepBody}>
            O laudo mostra o que vale conferir e por quê. Se você quiser
            contestar, o texto sai pronto no seu nome — quem envia é você.
          </p>
        </li>
      </ol>

      <p className={styles.footnote}>
        O arquivo enviado é apagado em 30 dias. Você não precisa criar conta
        para ver o laudo. Este produto não é escritório de cobrança e não
        recebe percentual de nada que você recuperar.
      </p>
    </main>
  );
}
