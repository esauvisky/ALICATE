# ALICATE

**A**plicação de **L**ogaritmos **I**nteligentes para **C**ombater o **A**liexpress e suas **T**axas **E**xcessivas.

*Porque dividir o carrinho do Aliexpress é melhor que dividir seu salário com o governo.*

> https://github.com/user-attachments/assets/c5e3d389-e885-4a3e-bd9b-ebc5ecf3332e
>
> _No vídeo: uma compra de $155 (9 produtos) teria $120 de impostos (total $275). Com o ALICATE, os impostos caíram para $78, uma economia de ~40%._

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
5. **Configure o AliExpress para usar USD (Dólares Americanos)** - o script só funciona com essa moeda
6. Vá fazer suas compras e deixe a mágica acontecer

## Como Usar

### Pré-requisitos
- Certifique-se de que o AliExpress está configurado para **USD**
- Se estiver em outra moeda, o script mostrará um aviso com instruções

### Passo a Passo

1.  **Planejamento (Checkout)**: Encha seu carrinho com todas as quinquilharias que você deseja. Vá para a página de checkout como se fosse um cidadão comum prestes a pagar uma fortuna em impostos. O script vai analisar a situação e, se houver uma maneira de ser mais esperto que o sistema, ele vai mostrar um plano para dividir seus pedidos. Não se preocupe, ele guarda o plano pra você. Clique no botão para voltar ao carrinho e começar a mágica.

2.  **Execução (Carrinho)**: De volta ao carrinho, uma nova interface divina aparecerá. Ela mostra os "splits" (as divisões) que o script calculou. Basta clicar em "Aplicar Passe 1" e ele selecionará os itens e ajustará as quantidades certas para aquele pedido.[^1] O script se lembra do plano original, então mesmo que você já tenha comprado metade das coisas, ele saberá o que falta. Gênio, né?

3.  **Finalize e Comemore**: Repita o processo para cada split. Pague seus pedidos um por um e sinta o doce sabor de ter economizado uma grana que iria direto para o bolso do governo. Você mereceu.

[^1]: **Atenção, Recruta (Itens com Quantidade > 1)**: Aqui é onde você precisa usar mais de dois neurônios. Se um item (digamos, 10x borrachinhas de pato) for dividido entre vários pedidos (7 no primeiro, 3 no segundo), você terá que fazer o seguinte:
    *   Aplique e compre o primeiro passe (com as 7 borrachinhas).
    *   Depois que a compra for feita, o item VAI SUMIR do seu carrinho. É assim que o AliExpress funciona, não culpe o mensageiro.
    *   Você terá que **readicionar o mesmo produto ao carrinho** (ao menos uma unidade das borrachinhas restantes) para poder comprar o segundo passe.
    *   Sim, é um pouco de trabalho manual. Eu automatizo o cálculo, não faço milagre. Se ficou confuso, **assista o vídeo de demonstração acima**. O script é decente o suficiente para te dar instruções no processo, então **leia as mensagens de aviso**.

## Detalhes Técnicos (ou "Como a Mágica Acontece")

Você deve estar se perguntando: "por que diabos dividir meu pedido funciona?". A resposta é simples e deprimente: a lógica tributária do governo.

1.  **A Guilhotina dos $50**: Compras internacionais abaixo de $50 USD (incluindo frete, não se esqueça) são abençoadas com uma taxa de imposto "menor". Acima disso, o governo decide que você é rico o suficiente para financiar o próximo escândalo de corrupção e aplica uma taxa muito maior, que pode chegar a quase o dobro do valor do seu produto.

2.  **A Ganância é a Chave**: O truque do ALICATE é tratar esse limite de $50 como um jogo. O objetivo é criar o maior número possível de pacotes cujo valor chegue o mais perto possível de $49.99, sem nunca ultrapassar. Um pedido de $150 paga um imposto brutal. Três pedidos de $50 pagam três impostos pequenos, e a soma deles é muito menor que o imposto do pedido único.

O script usa seus "logaritmos inteligentes" para analisar todos os seus itens e encontrar as combinações ideais para cada "split", maximizando o valor de cada pacote sem cruzar a linha fatal dos $50. É basicamente um Tetris com suas compras para ferrar o sistema. Legalmente, claro.

## Aviso Legal

Este script não faz nada ilegal. Ele simplesmente ajuda você a organizar suas compras de uma forma que seja mais favorável dentro das regras existentes. Se os governos não gostam disso, talvez devessem criar políticas menos predatórias.

## Contribuições

Pull requests são bem-vindos, especialmente se você tem ideias para tornar este script ainda mais eficaz em burlar... quer dizer, *otimizar* dentro das regras fiscais.

## Disclaimer

Use por sua própria conta e risco. Não sou responsável se o governo decidir mudar as regras porque muita gente está sendo esperta demais.

---

*"A única diferença entre morte e impostos é que a morte não piora toda vez que o Congresso se reúne."* - Will Rogers (provavelmente)
