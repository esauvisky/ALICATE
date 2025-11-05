# ALICATE

**A**plicação de **L**ogaritmos **I**nteligentes para **C**ombater o **A**liexpress e suas **T**axas **E**xcessivas.

*Porque dividir o carrinho do Aliexpress é melhor que dividir seu salário com o governo.*

<p align="center">
  https://github.com/user-attachments/assets/c5e3d389-e885-4a3e-bd9b-ebc5ecf3332e
  <br>
  <em>No vídeo: uma compra de $155 (9 produtos) teria $120 de impostos (total $275). Com o ALICATE, os impostos caíram para $78, uma economia de ~40%.</em>
</p>

## O Que Isso Faz

Este projeto são dois userscripts para Tampermonkey que ajudam você a pagar menos impostos nas compras do AliExpress dividindo pedidos de forma inteligente.

### Por Que Isso Existe?

Nossos queridos governantes decidiram que você não pode comprar suas coisas em paz. Eles criaram um sistema genial onde quanto mais você compra, maior o percentual de imposto que você paga. É tipo um castigo por querer economizar comprando várias coisas de uma vez.

O resultado? Compras pequenas pagam menos imposto proporcionalmente, compras grandes se fodem com taxas maiores.

Este script contorna essa lógica brilhante dividindo seus pedidos para que você pague as taxas menores sempre que possível.

## Como Funciona

### Script 1: Checkout Optimizer (`checkout.js`)
- Roda na página de checkout do AliExpress
- Analisa seus itens e calcula os impostos atuais
- Sugere como dividir o pedido para pagar menos impostos
- Mostra quanto você pode economizar (ou seja, quanto a menos o governo vai roubar de você)

### Script 2: Cart Split Applier (`cart.js`)
- Roda na página do carrinho
- Aplica automaticamente as divisões sugeridas
- Seleciona os itens corretos para cada pedido
- Ajusta quantidades quando necessário

## Instalação

1. Instale o [Tampermonkey](https://www.tampermonkey.net/) no seu navegador
2. Copie o conteúdo de `checkout.js` e crie um novo userscript
3. Copie o conteúdo de `cart.js` e crie outro userscript
4. Ative ambos os scripts
5. Vá fazer suas compras e deixe a mágica acontecer

## Como Usar

1. **No Checkout**: Adicione seus itens ao carrinho e vá para o checkout. O script vai mostrar sugestões de divisão e economia potencial.

2. **No Carrinho**: Se houver divisões sugeridas, você verá uma interface com botões para aplicar cada divisão automaticamente.

3. **Finalize**: Complete cada pedido separadamente e ria enquanto paga menos impostos.

## Configuração

- **Taxa de Imposto Ótima**: Por padrão é 45%, mas você pode ajustar na interface
- **Limite de Subtotal**: $49 USD (pode ser modificado no código)

## Aviso Legal

Este script não faz nada ilegal. Ele simplesmente ajuda você a organizar suas compras de uma forma que seja mais favorável dentro das regras existentes. Se os governos não gostam disso, talvez devessem criar políticas menos predatórias.

## Contribuições

Pull requests são bem-vindos, especialmente se você tem ideias para tornar este script ainda mais eficaz em burlar... quer dizer, *otimizar* dentro das regras fiscais.

## Disclaimer

Use por sua própria conta e risco. Não somos responsáveis se o governo decidir mudar as regras porque muita gente está sendo esperta demais.

---

*"A única diferença entre morte e impostos é que a morte não piora toda vez que o Congresso se reúne."* - Will Rogers (provavelmente)
