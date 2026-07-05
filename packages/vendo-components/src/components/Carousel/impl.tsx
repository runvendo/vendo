import { Carousel as UICarousel, CarouselContent, CarouselItem } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { allowlistUrl } from "../../impl-helpers/safe-url";
import { carouselSchema } from "./descriptor";

export const Carousel = createPrewiredImpl(carouselSchema, (p) => (
  <UICarousel variant="card" showButtons>
    <CarouselContent>
      {p.items.map((item, i) => {
        const safeImage = allowlistUrl(item.imageUrl);
        return (
          <CarouselItem key={i}>
            {safeImage ? <img src={safeImage} alt={item.title ?? ""} /> : null}
            {item.title ? <p>{item.title}</p> : null}
            {item.body ? <p>{item.body}</p> : null}
          </CarouselItem>
        );
      })}
    </CarouselContent>
  </UICarousel>
));
